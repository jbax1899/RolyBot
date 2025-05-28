const { openai } = require('./openaiHelper');
const MemoryManager = require('./memoryManager');
const { generateSystemMessage, generateSimilarMessagesSummary } = require('./contextGenerators');
const { injectContextFunctionTokens } = require('./responseUtils');
const { goAFK } = require('./openaiHelper');
const { buildInitialContext, enhanceContext } = require('./contextUtils');
const { generateAndRefineResponse } = require('./responseUtils');
const config = require('../config/responseConfig');
const { loadPosts } = require('./messageUtils');

// Use centralized memory manager to get memory retriever
const memoryRetriever = MemoryManager.memoryRetriever;

/**
 * Generates a response to a user message with context and refinement
 * @param {Object} client - Discord client instance
 * @param {Object} message - The message object from Discord
 * @param {string} replyContext - Additional context for the reply
 * @returns {Promise<string>} The generated response
 */
async function generateRolybotResponse(client, message, replyContext = '') {
    const userPrompt = replyContext + message.content;
    const channel = message.channel;
    
    try {
        // 1. Build initial context with system message and similar messages
        const { contextMessages, formattedHistory } = await buildInitialContext(
            userPrompt,
            channel,
            memoryRetriever,
            openai
        );

        // 2. Enhance context with function tokens and recent messages
        await enhanceContext(contextMessages, {
            client,
            userPrompt,
            userId: message.author.id,
            channel,
            openai,
            summaryModel: config.models.summary,
            goAFK: (client, duration, msg, setAFK) => goAFK(client, duration, msg, setAFK)
        });

        // 3. Add user prompt last
        contextMessages.push({ role: 'user', content: userPrompt });

        // 4. Generate and refine response
        return await generateAndRefineResponse(openai, contextMessages, {
            maxRetryAttempts: config.limits.maxRetryAttempts,
            model: config.models.primary,
            refineModel: config.models.refine,
            temperature: config.generation.temperature,
            maxTokens: config.generation.maxTokens
        });

    } catch (error) {
        console.error('Error generating response:', error);
        return "I'm sorry, I encountered an error while generating a response. Please try again.";
    }
}

module.exports = { generateRolybotResponse };