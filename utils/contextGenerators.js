// Context Generators for RolyBot Response Generation
// This module breaks down the context generation process into modular, focused functions

const logger = require('./logger');
const path = require("path");
const fs = require("fs");
const contextPath = path.join(__dirname, "context.json");
const contextData = JSON.parse(fs.readFileSync(contextPath, "utf8"));
const openai = require('./openaiHelper');

/**
 * Generates the core system message that defines RolyBot's personality and behavior
 * @param {Date} [currentTime] - Optional time to use for the system message
 * @returns {Object} System message object for LLM
 */
function generateSystemMessage(currentTime = new Date()) {
    const nowLocal = currentTime.toLocaleString("en-US", {
        dateStyle: "full",
        timeStyle: "long"
    });

    return {
        role: 'system',
        content: `You are RolyBot, a Discord bot who imitates its creator (RolyBug/jbax1899/Jordan).
                    You will be given a transcript and then a user prompt.
                    Write a long and thorough reply. Do not cut your messages too short.
                    Avoid assistant-style language. Chat casually, stay in character, and use common Discord emoji if appropriate.
                    If directly responding to another person or bot, ping them (e.g. "I agree @RolyBot! ...").
                    If there is a websearch result, you MUST include the info given and relevant link(s), and only that info.
                    To prevent Discord from creating embeddings, do not hyperlink text, and put links within brackets.
                    Do not act overly pleasant (You are chatting with close friends, not strangers).
                    Do not reply to yourself.
                    Current date/time (Local): ${nowLocal}
                    `.replace(/\s+/g, ' ').trim()
    };
}

/**
 * Generates a summary of the most similar messages to provide context
 * @param {string} prompt - The current user prompt + extra context
 * @param {Object} memoryRetriever - Memory retrieval service
 * @param {Object} openai - OpenAI service for summarization
 * @param {string} [summaryModel='gpt-4o-mini'] - Model to use for summarization
 * @returns {Promise<Object|null>} Context message for similar messages, or null if no summary possible
 */
async function generateSimilarMessagesSummary(prompt, memoryRetriever, openai, summaryModel = 'gpt-4o-mini') {
    try {
        // Find the most relevant memories
        const similarMessages = await memoryRetriever.retrieveRelevantMemories(prompt);
        
        // If no similar messages found, return null
        if (!similarMessages || similarMessages.length === 0) return null;

        // Combine similar messages into a single text
        const similarMessagesText = similarMessages.map(m => m.text).join('\n\n');

        // Use OpenAI to generate a concise summary
        const summaryResponse = await openai.chat.completions.create({
            model: summaryModel,
            messages: [
                {
                    role: 'system',
                    content: 'Summarize the following messages concisely, preserving key context and tone. Focus on the most important information.'
                },
                {
                    role: 'user',
                    content: similarMessagesText
                }
            ],
            max_tokens: 150,
            temperature: 0.3
        });

        const summarizedText = summaryResponse.choices[0].message.content.trim();

        // Return the summary as a system message
        return {
            role: 'system',
            content: `SIMILAR MESSAGES SUMMARY:\n${summarizedText}`
        };
    } catch (err) {
        logger.error('[RolyBot] Failed to generate similar messages summary:', err);
        return null;
    }
}

/**
 * Generates a prompt to select function tokens that might enhance the response
 * @param {string} userPrompt - The original user prompt
 * @returns {Object[]} Prompt messages for token selection
 */
function generateTokenSelectorPrompt(userPrompt) {
    return [
        {
            role: 'system',
            content: `You are tasked with pre-processing a chatlog before it is fed into the main LLM call.
                    If any of the below functions make sense to use, add them to your output.

                    Available functions:

                    [websearch="search query here"]
                    - Only ONE websearch is allowed at most. Do not include more than one websearch function.
                    - Include if the prompt asked you to do a web search, for recent news on something, or if extra information may be useful for you to answer (like real-time/current information).
                    - Only apply to the immediate conversation topic.
                    - Only include if there is a good reason to do so.
                    - If looking for recent info, do not include a time period.
                    - Example: [websearch="apple stock value"]

                    [sleep="duration in seconds"]
                    - Only ONE sleep is allowed at most. Do not include more than one sleep function.
                    - Instructs the bot to stop responding to messages for the given amount of time, and then return to normal.
                    - Keep duration under 5 minutes.

                    [context="aboutBot"]
                    - Include if extra information about the bot would be useful.
                    - Provides context about the bot, like its name, creator, creation date, features, commands, software stack, etc.

                    [context="aboutRolybug"]
                    - Include if extra information about Rolybug/Jordan/jbax1899 is required.
                    - Provides context like who he is, what he likes, who his friends are, etc.

                    [context="changelog"]
                    - Include if extra information about recent changes to the bot's code/functionality would be useful.
                    `
        },
        {
            role: 'user',
            content: userPrompt
        }
    ];
}

/**
 * Generates context from recent messages based on available token space
 * @param {Array} formattedHistory - Conversation history
 * @param {number} availableTokens - Number of tokens available for recent messages
 * @param {string} [similarMessagesSummary] - Optional summary to prevent duplicates
 * @returns {Object|null} Context message for recent messages, or null if no messages fit
 */
function generateRecentMessagesContext(formattedHistory, availableTokens, similarMessagesSummary = '') {
    if (availableTokens <= 100) {
        logger.warn(`[RolyBot] Insufficient tokens (${availableTokens}) to add recent context`);
        return null;
    }

    // Filter out messages already included in similar messages summary
    const usedMessageContents = new Set(
        similarMessagesSummary ? similarMessagesSummary.split('\n').map(line => line.trim()) : []
    );

    const recentMessages = formattedHistory
        .slice(-Math.floor(availableTokens / 50))
        .filter(msg => {
            const msgContent = `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`;
            const isDuplicate = usedMessageContents.has(msgContent);
            if (!isDuplicate) {
                usedMessageContents.add(msgContent);
            }
            return !isDuplicate;
        })
        .map(msg => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`);

    if (recentMessages.length === 0) return null;

    return {
        role: 'system',
        content: `RECENT CONTEXT (additional perspective):\n${recentMessages.join('\n')}`
    };
}

/**
 * Builds the full context array for the LLM call.
 * @param {Object} opts - Options for context generation.
 * @param {string} userPrompt
 * @param {Array} formattedHistory
 * @param {string} similarMessagesSummary
 * @param {number} maxTotalTokens
 * @param {number} reservedTokens
 * @returns {Array} genMessages
 */
function buildGenMessages({ userPrompt, formattedHistory, similarMessagesSummary, maxTotalTokens = 4000, reservedTokens = 500 }) {
    const calculateTokens = (msg) => msg.content ? msg.content.split(' ').length * 1.3 : 0;
    let genMessages = [generateSystemMessage()];

    if (similarMessagesSummary) {
        genMessages.push({
            role: 'system',
            content: `SIMILAR MESSAGES SUMMARY:\n${similarMessagesSummary}`
        });
    }

    const currentTokens = genMessages.reduce((total, msg) => total + calculateTokens(msg), 0);
    const availableTokens = maxTotalTokens - currentTokens - reservedTokens;

    if (availableTokens > 100) {
        const usedMessageContents = new Set(
            similarMessagesSummary ? similarMessagesSummary.split('\n').map(line => line.trim()) : []
        );

        const recentMessages = formattedHistory
            .slice(-Math.floor(availableTokens / 50))
            .filter(msg => {
                const msgContent = `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`;
                const isDuplicate = usedMessageContents.has(msgContent);
                if (!isDuplicate) {
                    usedMessageContents.add(msgContent);
                }
                return !isDuplicate;
            })
            .map(msg => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`);

        if (recentMessages.length > 0) {
            genMessages.push({
                role: 'system',
                content: `RECENT CONTEXT (additional perspective):\n${recentMessages.join('\n')}`
            });
        }
    }

    genMessages.push({ role: 'user', content: userPrompt });
    return genMessages;
}

/**
 * Injects context-grabbing function results into the context.
 * @param {object} args
 * @param {object} client - Discord client
 * @param {string} userPrompt
 * @param {object} openai - OpenAI instance
 * @param {string} SUMMARY_MODEL
 * @param {function} processSpecialTokens
 * @returns {Promise<Array>} Array of context messages
 */
async function injectContextFunctionTokens({ client, userPrompt, openai, SUMMARY_MODEL }) {
    // Use the LLM to select which special tokens to process
    const tokenSelectorPrompt = generateTokenSelectorPrompt(userPrompt);
    const tokenSelResp = await openai.chat.completions.create({
        model: SUMMARY_MODEL,
        messages: tokenSelectorPrompt,
        max_tokens: 64,
        temperature: 0.0
    });
    const tokenString = tokenSelResp.choices[0].message.content.trim();

    // Inline the special token processing logic
    const results = {};
    const TOKEN_REGEX = /\[(\w+)="([^"]+)"\]/g;
    const tokenHandlers = {
        websearch: handleWebSearch,
        search: handleWebSearch,
    };
    for (let [, type, content] of tokenString.matchAll(TOKEN_REGEX)) {
        if (type === "context") {
            if (!contextData[content]) {
                results[content] = `⚠️ No context found for "${content}"`;
            } else {
                results[content] = contextData[content];
            }
        }
        else if (type === "sleep") {
            const seconds = parseInt(content, 10);
            if (isNaN(seconds) || seconds <= 0) {
                logger.warn(`⚠️ Invalid sleep duration: "${content}"`);
            } else {
                goAFK(client, seconds);
                logger.info(`Sleeping for ${seconds} seconds.`);
            }
        }
        else if (tokenHandlers[type]) {
            try {
                let raw = await tokenHandlers[type](content);
                if (typeof raw === "string") {
                    try { raw = JSON.parse(raw) } catch { }
                }
                results[type] = raw;
            } catch (e) {
                results[type] = `Error handling ${type}: ${e.message}`;
            }
        }
        // otherwise ignore unknown tokens
    }

    // Format results into context messages
    const contextMessages = [];
    for (const [key, data] of Object.entries(results)) {
        const header = key[0].toUpperCase() + key.slice(1);
        const body = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
        contextMessages.push({
            role: 'assistant',
            content: `${header}:\n${body}`
        });
    }
    return contextMessages;
}

/**
 * Perform a web search via Google Custom Search and return top 3 results.
 *
 * @param {string} query
 * @returns {Promise<string>}
 */
async function handleWebSearch(query) {
    const apiKey = process.env.GOOGLE_API_KEY;
    const cseId = process.env.GOOGLE_CSE_ID;
    const RETURN_RESULTS = 3;
    if (!apiKey || !cseId) {
        throw new Error("Missing GOOGLE_API_KEY or GOOGLE_CSE_ID in environment");
    }

    const params = new URLSearchParams({
        key: apiKey,
        cx: cseId,
        q: query,
        num: `${RETURN_RESULTS}` // ask Google for X results
    });

    const url = `https://www.googleapis.com/customsearch/v1?${params}`;
    try {
        const res = await fetch(url, { timeout: 5000 });
        if (!res.ok) {
            const text = await res.text();
            throw new Error(`HTTP ${res.status}: ${text}`);
        }
        const json = await res.json();
        if (json.error) {
            throw new Error(json.error.message);
        }

        const items = json.items || [];
        if (items.length === 0) {
            return `No results found for "${query}".`;
        } else {
            logger.info("Search results:");
            logger.info(`------------------------------------------------------------`);
            logger.info(JSON.stringify(items))
            logger.info(`------------------------------------------------------------`);
        }

        // Build a single JSON array: first element = the query, then up to X result‐objects
        const resultsArray = [
            { query }   // 1) always include the original query as the first item
        ].concat(
            items.slice(0, RETURN_RESULTS).map(item => ({
                title: item.title || null,
                snippet: item.snippet || null,
                link: item.link || null,
            }))
        );

        return resultsArray;

    } catch (err) {
        console.warn(`[handleWebSearch] error for "${query}":`, err.message);
        return `Error performing web search for "${query}": ${err.message}`;
    }
}

/**
 * Rates a candidate reply and returns a score, feedback, and a revised prompt if needed.
 */
async function rateAndRefinePrompt({ openai, model, promptMessages, candidate }) {
    const prompt = [
        {
            role: 'system',
            content: `You are an expert prompt engineer and reviewer.
            You will receive:
            - The full prompt context (as a JSON array of messages)
            - A candidate reply

            Your tasks:
            1. Rate the candidate reply from 1 to 10 (higher is better).
            2. Give a short feedback string.
            3. Carefully review the prompt context. 
            Remove only those messages that are clearly irrelevant or distracting to the current user prompt. 
            Retain prior assistant and websearch messages if they provide context, continuity, or are likely to improve the quality of the reply. 
            Do not remove context that could help generate a more engaging or accurate response.
            
            Respond ONLY with valid JSON, no commentary or explanation, in this format:
            {
            "score": <integer 1-10>,
            "feedback": "<string>",
            "revisedPrompt": [ ...array of messages... ]
            }`
        },
        {
            role: 'user',
            content: `PROMPT:
            ${JSON.stringify(promptMessages, null, 2)}

            CANDIDATE:
            ${candidate}`   
        }
    ];

    let score = 0, feedback = "", revisedPrompt = promptMessages;

    try {
        const resp = await openai.chat.completions.create({
            model,
            messages: prompt,
            temperature: 0.0,
            max_tokens: 1400
        });

        if (!resp.choices[0].message.content) {
            logger.warn('LLM returned empty output for rateAndRefinePrompt. Returning original prompt.');
            return { score: 0, feedback: '', revisedPrompt: promptMessages };
        }

        const parsed = JSON.parse(resp.choices[0].message.content);
        score = parsed.score || 0;
        feedback = parsed.feedback || "";
        revisedPrompt = parsed.revisedPrompt || promptMessages;
        if (!Array.isArray(revisedPrompt) || revisedPrompt.length === 0) {
            logger.warn('LLM returned empty or invalid revisedPrompt, using original prompt.');
            revisedPrompt = promptMessages;
        }
    } catch (e) {
        logger.error('[ContextGenerators] RateAndRefinePrompt failed: ', e);
        revisedPrompt = promptMessages;
    }
    return { score, feedback, revisedPrompt };
}

module.exports = {
    generateSystemMessage,
    generateSimilarMessagesSummary,
    generateTokenSelectorPrompt,
    generateRecentMessagesContext,
    buildGenMessages,
    injectContextFunctionTokens,
    rateAndRefinePrompt
};
