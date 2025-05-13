const logger = require('./logger');
const {
    generateSystemMessage,
    generateSimilarMessagesSummary,
    injectContextFunctionTokens,
    rateAndRefinePrompt
} = require('./contextGenerators');
const MemoryManager = require('./memoryManager');
const { openai } = require('./openaiHelper');

// Use centralized memory manager to get memory retriever
const memoryRetriever = MemoryManager.memoryRetriever;

// Constants
const MAX_HISTORY = 20;
const MAX_RETRY_ATTEMPTS = 3;
const PASS_THRESHOLD = 7;           // 1–10 scale
const SUMMARY_MODEL = 'gpt-4o-mini';
const PRIMARY_MODEL = 'ft:gpt-4.1-2025-04-14:personal:rolybot:BOJYk0lB';
const PROMPT_REFINE_MODEL = 'gpt-4o-mini';

async function generateRolybotResponse(client, message, replyContext = '') {
    const userPrompt = message.content;
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
    const formattedHistory = history
        .filter(e => e.content && e.content.trim() !== '')
        .map(e =>
            e.role === 'user'
                ? { role: 'user', content: `${e.username}: ${e.content}` }
                : { role: 'assistant', content: e.content }
        );

    // b. Find most similar messages and generate a summary
    const similarMessagesSummary = await generateSimilarMessagesSummary(
        userPrompt, 
        memoryRetriever, 
        openai
    );

    // 3) Inject context function tokens
    const MAX_TOTAL_TOKENS = 6000;
    const RESERVED_TOKENS = 500;
    // Start with system message and summary
    let contextMessages = [systemMessage];
    if (similarMessagesSummary) contextMessages.push(similarMessagesSummary);

    // 3b) Inject function tokens
    const contextFunctionMessages = await injectContextFunctionTokens({
        client,
        userPrompt: userPrompt + (similarMessagesSummary?.content || ''),
        openai,
        SUMMARY_MODEL
    });
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

    // 6) Generate and iteratively refine using rateAndRefinePrompt
    let promptMessages = [...contextMessages];
    let bestReply = null;
    let bestScore = -Infinity;
    let feedbackHistory = [];

    logger.info('===== FINAL MESSAGES TO LLM =====');
    logger.info(promptMessages.map(msg => 
        `[${msg.role.toUpperCase()}] ${msg.content}`
    ).join('\n\n'));
    logger.info('===== END FINAL MESSAGES =====');

    logger.info(`\n[RolyBot] Generating with ${PRIMARY_MODEL}`);

    for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
        // Generate candidate
        let candidate;
        try {
            const ft = await openai.chat.completions.create({
                model: PRIMARY_MODEL,
                messages: promptMessages,
                temperature: 0.7,
                max_tokens: 600
            });
            candidate = ft.choices[0].message.content.trim();
        } catch (e) {
            logger.error(`Generation failed (attempt ${attempt}):`, e);
            break;
        }
        logger.info(`Candidate (attempt ${attempt}):\n${candidate}`);

        // Use the new rateAndRefinePrompt for rating and refinement
        const { score, feedback, revisedPrompt } = await rateAndRefinePrompt({
            openai,
            model: PROMPT_REFINE_MODEL,
            promptMessages,
            candidate
        });
        feedbackHistory.push({ candidate, score, feedback });
        logger.info(`Rating (attempt ${attempt}): ${score}/10
            Feedback: ${feedback}
            Revised Prompt: 
            ${JSON.stringify(revisedPrompt, null, 2)}`);

        // Track best reply
        if (score > bestScore) {
            bestReply = candidate;
            bestScore = score;
        }

        // If good enough, break
        if (score >= PASS_THRESHOLD) {
            logger.info('High-quality candidate found, stopping early.');
            break;
        }

        // Use the revised prompt for the next attempt
        promptMessages = revisedPrompt;
        logger.info('Prompt after refinement:', JSON.stringify(promptMessages, null, 2));
    }

    if (!bestReply) bestReply = "Sorry, I had trouble thinking of a response :(";

    // Return the best candidate and score
    return {
        reply: bestReply,
        score: bestScore,
        feedbackHistory
    };
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
        return {
            role: isMe ? 'assistant' : 'user',
            // if it's _not_ me, prepend the username so the LLM knows who said what
            content: isMe ? m.content : `${m.author.username}: ${m.content}`,
            username: m.author.username
        };
    });
}

module.exports = generateRolybotResponse;