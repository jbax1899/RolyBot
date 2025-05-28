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
        const history = await loadPosts(channel, 20);
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
        // Add function tokens if available
        if (injectContextFunctionTokens) {
            const functionMessages = await injectContextFunctionTokens({
                client,
                userPrompt,
                openai,
                SUMMARY_MODEL: summaryModel,
                discordUserId: userId,
                goAFK
            });
            contextMessages.push(...functionMessages);
        }

        // Add recent messages (deduped)
        const dedupeSet = new Set(contextMessages.map(m => m.content));
        const history = await loadPosts(channel, 20);
        const recentUnique = history
            .filter(msg => msg?.content && !dedupeSet.has(msg.content));
            
        // Simple token management (crude estimation)
        let tokenCount = contextMessages.reduce((sum, m) => sum + (m.content?.length || 0), 0);
        const MAX_TOKENS = 6000;
        const RESERVE_TOKENS = 500;
        
        for (const msg of recentUnique) {
            const msgTokens = msg.content?.length || 0;
            if (tokenCount + msgTokens > (MAX_TOKENS - RESERVE_TOKENS)) break;
            contextMessages.push(msg);
            tokenCount += msgTokens;
        }
    } catch (error) {
        logger.error('Error enhancing context:', error);
    }
}

module.exports = {
    buildInitialContext,
    enhanceContext
};
