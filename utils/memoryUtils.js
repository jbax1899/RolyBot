const logger = require('./logger');

// Memory initialization state
let isMemoryInitialized = false;
let initializationPromise = null;

// Lazy load the MemoryManager to avoid circular dependencies
let _memoryManager = null;

/**
 * Get the memory manager instance with lazy loading
 * @returns {Object} MemoryManager instance
 */
function getMemoryManager() {
    if (!_memoryManager) {
        const MemoryManager = require('./memoryManager');
        _memoryManager = MemoryManager.instance || MemoryManager.getInstance();
    }
    return _memoryManager;
}

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
            const memoryManager = getMemoryManager();
            
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
 * @returns {Object|null} Memory retriever instance or null if not available
 */
function getMemoryRetriever() {
    try {
        const memoryManager = getMemoryManager();
        if (!memoryManager || !memoryManager.isInitialized) {
            logger.warn('Memory manager not initialized');
            return null;
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
