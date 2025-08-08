const { openai } = require('./openaiHelper');
const MemoryManager = require('./memoryManager');
const { goAFK } = require('./openaiHelper');
const { buildInitialContext, enhanceContext } = require('./contextUtils');
const { generateAndRefineResponse } = require('./responseUtils');
const config = require('../config/responseConfig');
const logger = require('./logger');

// Get memory manager instance
const memoryManager = require('./memoryManager').getInstance();

// Get memory retriever from the memory manager instance
const memoryRetriever = memoryManager.memoryRetriever;

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

        // 2. Add recent message history to context
        if (formattedHistory && formattedHistory.length > 0) {
            // Add each historical message to context
            formattedHistory.forEach(msg => {
                contextMessages.push({
                    role: msg.isBot ? 'assistant' : 'user',
                    content: msg.content,
                    name: msg.username
                });
            });
        }

        // 3. Enhance context with function tokens and other metadata
        await enhanceContext(contextMessages, {
            client,
            userPrompt,
            userId: message.author.id,
            channel,
            openai,
            summaryModel: config.models.summary,
            goAFK: (client, duration, msg, setAFK) => goAFK(client, duration, msg, setAFK)
        });

        // 4. Add user prompt last
        contextMessages.push({ role: 'user', content: userPrompt });

        // 5. Log the full context
        logger.info('Full context:', JSON.stringify(contextMessages, null, 2));

        // 6. Generate and refine response
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