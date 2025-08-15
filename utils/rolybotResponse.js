const { openai } = require('./openaiHelper');
const MemoryManager = require('./memoryManager');
const { goAFK } = require('./openaiHelper');
const { buildInitialContext, enhanceContext } = require('./contextUtils');
const { generateAndRefineResponse } = require('./responseUtils');
const config = require('../config/responseConfig');
const logger = require('./logger');

// Import memory utilities
const { getMemoryRetriever } = require('./memoryUtils');

// Lazy initialize memory retriever
let _memoryRetriever = null;

/**
 * Get the memory retriever instance with lazy initialization
 * @returns {Object|null} Memory retriever instance or null if not available
 */
function getMemoryRetrieverInstance() {
    if (!_memoryRetriever) {
        try {
            _memoryRetriever = getMemoryRetriever();
            if (!_memoryRetriever) {
                logger.warn('Memory retriever not available');
            }
        } catch (error) {
            logger.error('Failed to get memory retriever:', error);
        }
    }
    return _memoryRetriever;
}

/**
 * Generates a response to a user message with context and refinement
 * @param {Object} client - Discord client instance
 * @param {Object} message - The message object from Discord
 * @param {string} replyContext - Additional context for the reply
 * @returns {Promise<string>} The generated response
 */
async function generateRolybotResponse(client, message, replyContext = '') {
    if (!client || !message || !message.channel) {
        logger.error('Invalid parameters provided to generateRolybotResponse');
        return "I'm having trouble understanding the request. Please try again.";
    }
    
    // Get memory retriever instance
    const memoryRetriever = getMemoryRetrieverInstance();
    if (!memoryRetriever) {
        logger.warn('Memory retriever not available, continuing without memory functionality');
    }

    const userPrompt = (replyContext ? replyContext + ' ' : '') + message.content;
    const channel = message.channel;
    
    try {
        // 1. Validate memory retriever
        if (!memoryRetriever || typeof memoryRetriever.retrieveRelevantMemories !== 'function') {
            logger.error('Memory retriever not properly initialized');
            return "I'm having trouble accessing my memory. Please try again in a moment.";
        }

        // 2. Build initial context with system message and similar messages
        let contextMessages, formattedHistory;
        try {
            const contextResult = await buildInitialContext(
                userPrompt,
                channel,
                memoryRetriever,
                openai
            );
            
            if (!contextResult) {
                throw new Error('Failed to build initial context');
            }
            
            ({ contextMessages = [], formattedHistory = [] } = contextResult);
        } catch (contextError) {
            logger.error('Error building initial context:', contextError);
            contextMessages = [];
            formattedHistory = [];
        }

        // 3. Add recent message history to context if available
        if (Array.isArray(formattedHistory) && formattedHistory.length > 0) {
            formattedHistory.forEach(msg => {
                try {
                    if (msg?.content) {
                        contextMessages.push({
                            role: msg.isBot ? 'assistant' : 'user',
                            content: msg.content,
                            name: msg.username || 'user'
                        });
                    }
                } catch (msgError) {
                    logger.error('Error processing message history:', msgError);
                }
            });
        }

        // 4. Enhance context with additional metadata
        try {
            await enhanceContext(contextMessages, {
                client,
                userPrompt,
                userId: message.author?.id,
                channel,
                openai,
                summaryModel: config.models.summary,
                goAFK: (client, duration, msg, setAFK) => goAFK(client, duration, msg, setAFK)
            });
        } catch (enhanceError) {
            logger.warn('Error enhancing context, continuing with basic context:', enhanceError);
        }

        // 5. Add current user prompt
        contextMessages.push({ 
            role: 'user', 
            content: userPrompt,
            name: message.author?.username || 'user'
        });

        // 6. Log the context for debugging (truncated to avoid log spam)
        logger.info('Response context:', {
            messageCount: contextMessages.length,
            lastMessage: contextMessages[contextMessages.length - 1]?.content?.substring(0, 100) + '...',
            hasHistory: formattedHistory.length > 0
        });

        // 7. Generate and refine response with retry logic
        try {
            return await generateAndRefineResponse(openai, contextMessages, {
                maxRetryAttempts: config.limits.maxRetryAttempts || 3,
                model: config.models.primary,
                refineModel: config.models.refine,
                temperature: config.generation.temperature || 0.7,
                maxTokens: config.generation.maxTokens || 1000
            });
        } catch (genError) {
            logger.error('Error generating response:', genError);
            return "I'm having trouble formulating a response right now. Could you rephrase your request?";
        }

    } catch (error) {
        logger.error('Critical error in generateRolybotResponse:', error);
        return "I've encountered an unexpected error. The issue has been logged. Please try again.";
    }
}

module.exports = { generateRolybotResponse };