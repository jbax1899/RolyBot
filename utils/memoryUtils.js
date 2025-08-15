const logger = require('./logger');
const MemoryManager = require('./memoryManager');

// Memory initialization state
let isMemoryInitialized = false;
let initializationPromise = null;

/**
 * Ensures memory is properly initialized before proceeding
 * @param {Object} client - Discord client instance
 * @returns {Promise<boolean>} True if initialization was successful
 */
async function ensureMemoryInitialized(client) {
    if (isMemoryInitialized) {
        return true;
    }

    // If initialization is already in progress, wait for it to complete
    if (initializationPromise) {
        return initializationPromise;
    }

    initializationPromise = (async () => {
        try {
            const memoryManager = MemoryManager.getInstance();
            
            // Initialize with default settings if not already initialized
            if (!memoryManager.isInitialized) {
                logger.info('Initializing memory manager...');
                await memoryManager.initialize(client);
                
                // Load initial memories if needed
                if (memoryManager.priorityChannelIds?.length > 0) {
                    logger.info(`Loading initial memories from ${memoryManager.priorityChannelIds.length} channels`);
                    await memoryManager.initializeMemoriesFromHistory(
                        client,
                        memoryManager.priorityChannelIds,
                        100 // Load last 100 messages from each channel
                    );
                }
            }
            
            isMemoryInitialized = true;
            logger.info('Memory initialization completed successfully');
            return true;
        } catch (error) {
            logger.error('Memory initialization failed:', error);
            isMemoryInitialized = false;
            throw error;
        } finally {
            initializationPromise = null;
        }
    })();

    return initializationPromise;
}

/**
 * Safely retrieves the memory retriever instance
 * @returns {Object} Memory retriever instance
 */
function getMemoryRetriever() {
    try {
        const memoryManager = MemoryManager.getInstance();
        if (!memoryManager.isInitialized) {
            throw new Error('Memory manager not initialized');
        }
        return memoryManager.memoryRetriever;
    } catch (error) {
        logger.error('Failed to get memory retriever:', error);
        return null;
    }
}

module.exports = {
    ensureMemoryInitialized,
    getMemoryRetriever,
    isMemoryInitialized: () => isMemoryInitialized
};
