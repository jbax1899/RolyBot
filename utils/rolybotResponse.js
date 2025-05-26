const logger = require('./logger');
const { recordRolybotRequest, tooManyRolybotRequests, goAFK } = require('./openaiHelper');
const {
    generateSystemMessage,
    generateSimilarMessagesSummary,
    injectContextFunctionTokens,
    refinePrompt
} = require('./contextGenerators');
const MemoryManager = require('./memoryManager');
const { openai } = require('./openaiHelper');

// Use centralized memory manager to get memory retriever
const memoryRetriever = MemoryManager.memoryRetriever;

// Constants
const MAX_HISTORY = 20;
const MAX_RETRY_ATTEMPTS = 1;
const SUMMARY_MODEL = 'gpt-4o-mini';
const PRIMARY_MODEL = 'ft:gpt-4.1-2025-04-14:personal:rolybot:BOJYk0lB';
const PROMPT_REFINE_MODEL = 'gpt-4o-mini';

async function generateRolybotResponse(client, message, replyContext = '') {
    const userPrompt = replyContext + message.content;
    const channel = message.channel;

    // 1) System message
    const systemMessage = generateSystemMessage();

    // 2) Summary of similar messages
    // a. Load and format history
    let history = [];
    try {
        history = await loadPosts(channel, MAX_HISTORY);
    } catch (err) {
        logger.error('[RolyBot] Failed to load channel history:', err);
    }
    // Format history - usernames are already included in content by loadPosts
    const formattedHistory = history
        .filter(e => e.content && e.content.trim() !== '')
        .map(e => ({
            role: e.role,
            content: e.content,
            username: e.username,
            isBot: e.isBot
        }));

    // b. Find most similar messages and generate a summary
    /*
    const similarMessagesSummary = await generateSimilarMessagesSummary(
        userPrompt, 
        memoryRetriever, 
        openai
    );
    */

    // 3) Inject context function tokens
    const MAX_TOTAL_TOKENS = 6000;
    const RESERVED_TOKENS = 500;
    // Start with system message and summary
    let contextMessages = [systemMessage];
    // TODO: Re-enable similar messages summary
    //if (similarMessagesSummary) contextMessages.push(similarMessagesSummary);

    // 3b) Log the full context before sending to model
    logger.info('===== FINAL PROMPT TO MAIN MODEL =====');
    contextMessages.forEach((msg, i) => {
        logger.info(`[${i}] ${msg.role.toUpperCase()}:\n${msg.content}\n`);
    });
    logger.info('===== END FINAL PROMPT =====\n');

    // 3c) Inject function tokens
    let contextFunctionMessages = [];
    try {
        contextFunctionMessages = await injectContextFunctionTokens({
            client,
            userPrompt: userPrompt,
            openai,
            SUMMARY_MODEL,
            discordUserId: message.author.id,
            goAFK: (client, duration, message, setAFK) => goAFK(client, duration, message, setAFK)
        });
    } catch (err) {
        logger.error('[RolyBot] Failed to inject context function tokens:', err);
    }
    contextMessages.push(...contextFunctionMessages);

    // 4) Add as many recent unique messages as will fit (deduped, token-aware)
    // Build a set of all message contents already in context (summary, function tokens)
    const dedupeSet = new Set(contextMessages.map(m => m.content));
    // Only add recent messages that are not already present
    const recentUnique = formattedHistory.filter(m => !dedupeSet.has(m.content));
    // Token-aware padding: keep adding until token budget is hit
    let totalTokens = contextMessages.reduce((sum, m) => sum + (m.content ? m.content.length : 0), 0); // crude token est
    for (const msg of recentUnique) {
        if (totalTokens + (msg.content ? msg.content.length : 0) > (MAX_TOTAL_TOKENS - RESERVED_TOKENS)) break;
        contextMessages.push(msg);
        totalTokens += (msg.content ? msg.content.length : 0);
    }

    // 5) Add user prompt last
    contextMessages.push({ role: 'user', content: userPrompt });

    // 6) Generate response, with optional refinement
    let promptMessages = [...contextMessages];
    let bestReply = null;
    let feedbackHistory = [];
    let previousCandidates = [];
    
    // Generate a single response with the current context
    const generateResponse = async (context) => {
        const response = await openai.chat.completions.create({
            model: PRIMARY_MODEL,
            messages: context,
            temperature: 0.7,
            max_tokens: 600
        });
        return response.choices[0].message.content.trim();
    };
    
    // Always enter the loop at least once, but only refine if MAX_RETRY_ATTEMPTS > 0
    const maxAttempts = Math.max(1, MAX_RETRY_ATTEMPTS);
    
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        // Log the exact messages being sent to the model
        logger.info(`\n===== ATTEMPT ${attempt}/${maxAttempts} =====`);
        logger.info(`[RolyBot] Generating with model: ${PRIMARY_MODEL}`);
        
        // Format all messages for logging with clear separation
        const logOutput = [
            `\n===== MESSAGE CONTEXT (Attempt ${attempt}/${maxAttempts}) =====`,
            `Model: ${PRIMARY_MODEL}`,
            `Feedback History: ${feedbackHistory.length ? feedbackHistory.join(' | ') : 'None'}`,
            `Previous Attempts: ${previousCandidates.length}`,
            '' // Empty line for better readability
        ];
        
        // Log previous attempts if any
        if (previousCandidates.length > 0) {
            logOutput.push('=== PREVIOUS ATTEMPTS ===');
            previousCandidates.forEach((cand, i) => {
                logOutput.push(`--- ATTEMPT ${i + 1} ---\n${cand.candidate}\n\nFEEDBACK: ${cand.feedback}\n`);
            });
        }
        
        // Group messages by type for better organization
        const systemMessages = promptMessages.filter(m => m.role === 'system');
        const userMessages = promptMessages.filter(m => m.role === 'user');
        const assistantMessages = promptMessages.filter(m => m.role === 'assistant');
        
        // Log system messages
        if (systemMessages.length > 0) {
            logOutput.push('=== SYSTEM MESSAGES ===');
            systemMessages.forEach((msg, i) => {
                logOutput.push(`[System ${i}]\n${msg.content}\n`);
            });
        }
        
        // Log conversation in chronological order
        if (userMessages.length > 0 || assistantMessages.length > 0) {
            logOutput.push('=== CONVERSATION ===');
            
            // Combine and sort all messages by their position in the array
            const allMessages = promptMessages
                .map((msg, index) => ({
                    ...msg,
                    type: msg.role === 'system' ? 'system' : 
                          msg.role === 'assistant' ? 'assistant' : 'user',
                    index
                }))
                .filter(msg => msg.type !== 'system');
            
            allMessages.forEach(msg => {
                const role = msg.type.toUpperCase();
                const content = msg.content;
                logOutput.push(`[${role}]\n${content}\n`);
            });
        }
        
        logOutput.push('='.repeat(60));  // Footer separator
        
        // Log the complete context
        logger.info(logOutput.join('\n'));
        
        // If refinement is disabled, generate and return the response
        if (MAX_RETRY_ATTEMPTS <= 0) {
            bestReply = await generateResponse(promptMessages);
            logger.info(`Generated response (refinement disabled):\n${bestReply}`);
            return bestReply;
        }
        
        let candidate;
        try {
            // Generate response with current context
            candidate = await generateResponse(promptMessages);
            logger.info(`Candidate (attempt ${attempt}):\n${candidate}`);

            // Get refinement suggestions for the current candidate
            const refinement = await refinePrompt({
                openai,
                model: PROMPT_REFINE_MODEL,
                promptMessages,
                candidate,
                attempt,
                feedbackHistory: [...feedbackHistory], // Pass a copy to avoid mutation
                previousCandidates: [...previousCandidates] // Pass previous attempts
            });

            // If the response is marked as good, use it as is
            if (refinement === '[GOOD]') {
                bestReply = candidate;
                logger.info(`✅ Response passed quality check on attempt ${attempt}`);
                return bestReply;
            }
            
            try {
                // Process refinement feedback
                const feedbackMatch = refinement.match(/SUGGESTED IMPROVEMENTS:([\s\S]*?)(?=REVISED VERSION:|$)/i);
                const feedback = feedbackMatch ? feedbackMatch[1].trim() : 'No specific feedback provided';
                
                // Add to previous candidates with feedback
                previousCandidates.push({
                    candidate,
                    feedback,
                    attempt
                });
                
                // Extract the revised version if available
                const revisedMatch = refinement.match(/REVISED VERSION:([\s\S]*)$/i);
                if (revisedMatch) {
                    const revisedContent = revisedMatch[1].trim();
                    if (revisedContent) {
                        // Add the revised version as a new candidate
                        previousCandidates.push({
                            candidate: revisedContent,
                            feedback: 'Automatically generated revision',
                            attempt: attempt + 0.5 // Use decimal to indicate it's a revision
                        });
                    }
                }
                
                // Add feedback to history (trim to avoid excessive length)
                const feedbackSummary = feedback.split('\n')[0].substring(0, 200);
                feedbackHistory.push(feedbackSummary);
                
                // Keep only the most recent feedback items
                if (feedbackHistory.length > 3) {
                    feedbackHistory.shift();
                }
                
                // If we've reached max attempts, use the best we have
                if (attempt >= MAX_RETRY_ATTEMPTS) {
                    logger.warn(`Max retry attempts (${MAX_RETRY_ATTEMPTS}) reached, using best response`);
                    return bestReply || candidate;
                }

                // Otherwise, update the prompt with the refinement feedback
                promptMessages = [
                    ...promptMessages,
                    {
                        role: 'assistant',
                        content: candidate
                    },
                    {
                        role: 'user',
                        content: `Please improve this response based on the following feedback:\n\n${refinement}`
                    }
                ];
            } catch (error) {
                logger.error('Error processing refinement feedback:', error);
                // If there's an error, just return the current candidate
                return candidate;
            }
        } catch (e) {
            logger.error(`Generation failed (attempt ${attempt}):`, e);
            feedbackHistory.push({ candidate, error: e.message });
            
            if (attempt === MAX_RETRY_ATTEMPTS) {
                // If we're out of attempts, use the last candidate if we have one
                return candidate || "Sorry, I had trouble thinking of a response :(";
            }
        }
    }

    return "Sorry, I had trouble thinking of a response :(";
}

/**
 * Fetches the last MAX_HISTORY messages from the given TextChannel,
 * sorts them oldest→newest, and maps them into
 * { role: 'user'|'assistant', content, username } entries.
 *
 * Only messages authored by _this_ bot become role:'assistant'.
 * Everyone else (people or other bots) are role:'user'.
 */
async function loadPosts(channel, limit = MAX_HISTORY) {
    // fetch the most recent `limit` messages
    const fetched = await channel.messages.fetch({ limit });
  
    // sort oldest→newest
    const sorted = Array.from(fetched.values())
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  
    // grab _this_ bot's ID
    const myBotId = channel.client.user.id;
  
    // map into our chat‑format
    return sorted.map(m => {
        const isMe = m.author.id === myBotId;
        const isBot = m.author.bot && !isMe;
        
        // Only prepend username for non-our-bot messages
        let content = m.content;
        if (!isMe && !content.startsWith(`${m.author.username}:`)) {
            content = `${m.author.username}: ${content}`;
        }
        
        return {
            role: isMe ? 'assistant' : 'user',
            content: content,
            username: m.author.username,
            isBot: isBot
        };
    });
}

module.exports = { generateRolybotResponse, loadPosts };