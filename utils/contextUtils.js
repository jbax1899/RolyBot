const { generateSystemMessage, generateSimilarMessagesSummary } = require('./contextGenerators');
const { loadPosts } = require('./messageUtils');
const logger = require('./logger');

/**
 * Builds the initial context for the response generation
 * @param {string} userPrompt - The user's input prompt
 * @param {Object} channel - The Discord channel object
 * @param {Object} memoryRetriever - The memory retriever instance
 * @param {Object} openai - The OpenAI API client
 * @returns {Promise<Array>} Array of context messages
 */
async function buildInitialContext(userPrompt, channel, memoryRetriever, openai) {
    const contextMessages = [generateSystemMessage()];
    
    try {
        const history = await loadPosts(channel, 10);
        const formattedHistory = history
            .filter(e => e?.content?.trim())
            .map(({ role, content, username, isBot }) => ({
                role,
                content,
                username,
                isBot
            }));

        const similarSummary = await generateSimilarMessagesSummary(
            userPrompt, 
            memoryRetriever, 
            openai
        );
        
        if (similarSummary) {
            contextMessages.push(similarSummary);
        }
        
        return { contextMessages, formattedHistory };
    } catch (error) {
        logger.error('Error building initial context:', error);
        return { contextMessages, formattedHistory: [] };
    }
}

/**
 * Enhances the context with function tokens and recent messages
 * @param {Array} contextMessages - The current context messages
 * @param {Object} options - Options for context enhancement
 * @returns {Promise<void>}
 */
async function enhanceContext(contextMessages, options) {
    const { 
        client, 
        userPrompt, 
        userId, 
        channel, 
        openai, 
        summaryModel,
        goAFK
    } = options;

    try {
        // Get recent messages (excluding the current user's message which was just added)
        const history = await loadPosts(channel, 20);
        
        // Create a map of existing message contents for deduplication
        const existingContents = new Set(contextMessages.map(m => m.content));
        
        // Filter and process messages
        const recentMessages = [];
        let tokenCount = contextMessages.reduce((sum, m) => sum + (m.content?.length || 0), 0);
        const MAX_TOKENS = 6000;
        const RESERVE_TOKENS = 500;
        
        // Process messages in reverse chronological order (newest first)
        for (const msg of history) {
            if (!msg?.content || 
                existingContents.has(msg.content) || 
                msg.content === userPrompt) {
                continue; // Skip duplicates, empty messages, and the current prompt
            }
            
            const msgTokens = msg.content.length;
            if (tokenCount + msgTokens > (MAX_TOKENS - RESERVE_TOKENS)) {
                break; // Stop if we're running out of token space
            }
            
            recentMessages.unshift({ // Add to beginning to maintain chronological order
                role: 'user', // Always use 'user' role for all messages, including from bots
                content: msg.content,
                name: msg.username || (msg.isBot ? 'bot' : 'user'),
                timestamp: msg.timestamp || Date.now(),
                isBot: msg.isBot // Keep track of bot status for reference
            });
            
            existingContents.add(msg.content);
            tokenCount += msgTokens;
        }
        
        // Add the processed messages to the beginning of the context (after system messages)
        const systemMessages = contextMessages.filter(m => m.role === 'system');
        const otherMessages = contextMessages.filter(m => m.role !== 'system');
        contextMessages = [...systemMessages, ...recentMessages, ...otherMessages];
        
    } catch (error) {
        logger.error('Error enhancing context:', error);
    }
}

module.exports = {
    buildInitialContext,
    enhanceContext
};
