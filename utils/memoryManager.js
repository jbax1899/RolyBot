// Import MemoryRetriever with error handling
let MemoryRetriever;
try {
    MemoryRetriever = require('./memoryRetrieval').MemoryRetriever;
} catch (error) {
    console.error('Failed to load MemoryRetriever:', error);
    // Create a dummy MemoryRetriever class if the real one can't be loaded
    MemoryRetriever = class DummyMemoryRetriever {
        constructor() {}
        async initialize() {}
        async addMemory() {}
        async retrieveRelevantMemories() { return []; }
    };
}

const logger = require('./logger');

// Default configuration
const DEFAULT_CONFIG = {
    priorityChannelIds: [],
    maxMemorySize: 500,
    memoryRateLimit: 60,
    memoryRateLimitWindow: 1000, // ms
    preprocessingConfig: {
        tokenLimit: 500,
        embeddingDimension: 768,
        similarityThreshold: 0.7
    }
};

class MemoryManager {
    /**
     * Get the singleton instance of MemoryManager
     * @returns {MemoryManager} The singleton instance
     */
    static getInstance() {
        if (!this._instance) {
            this._initializing = true;
            this._instance = new MemoryManager();
            this._initializing = false;
        }
        return this._instance;
    }

    // Private static instance variable
    static _instance = null;
    // Lock for thread safety during initialization
    static _initializing = false;

    /**
     * Private constructor to enforce singleton pattern
     * @private
     */
    constructor() {
        // Prevent direct construction calls with new operator
        if (MemoryManager._instance && !MemoryManager._initializing) {
            throw new Error('Use MemoryManager.getInstance() instead of new operator');
        }

        this._memoryRetriever = null;
        this._isInitialized = false;
        this._initializationInProgress = false;
        
        // Initialize with default values from global config or use defaults
        this._defaultConfig = {
            ...DEFAULT_CONFIG,
            ...(global.MEMORY_CONFIG ? {
                priorityChannelIds: global.MEMORY_CONFIG.PRIORITY_CHANNEL_ID ? 
                    [global.MEMORY_CONFIG.PRIORITY_CHANNEL_ID] : [],
                maxMemorySize: global.MEMORY_CONFIG.MAX_MEMORY_SIZE,
                memoryRateLimit: global.MEMORY_CONFIG.MEMORY_RATE_LIMIT
            } : {})
        };

        MemoryManager._instance = this;
    }

    /**
     * Get the memory retriever instance
     * @returns {MemoryRetriever} The memory retriever instance
     */
    get memoryRetriever() {
        // If we already have a memory retriever, return it
        if (this._memoryRetriever) {
            return this._memoryRetriever;
        }

        // If initialization is already in progress, return null to avoid multiple initializations
        if (this._initializationInProgress) {
            return null;
        }

        logger.warn('[MemoryManager] Memory retriever accessed before initialization, initializing with default settings');
        
        // Try to initialize with default settings
        try {
            this._initializationInProgress = true;
            
            // Create a new memory retriever with default settings
            this._memoryRetriever = new MemoryRetriever({
                ...this._defaultConfig,
                // Add any additional default options here
            });
            
            this._isInitialized = true;
            logger.info('[MemoryManager] Memory retriever initialized with default settings');
            
            return this._memoryRetriever;
            
        } catch (error) {
            logger.error('[MemoryManager] Failed to initialize memory retriever with default settings:', error);
            // Return a dummy memory retriever that won't cause errors
            return {
                addMemory: () => Promise.resolve(),
                retrieveRelevantMemories: () => Promise.resolve([]),
                isDummy: true
            };
        } finally {
            this._initializationInProgress = false;
        }
    }

    async initialize(client, customOptions = {}) {
        // If already initialized, return the existing retriever
        if (this._isInitialized) {
            logger.info('[MemoryManager] Already initialized');
            return this._memoryRetriever;
        }

        // Prevent multiple initializations
        if (this._initializationInProgress) {
            logger.warn('[MemoryManager] Initialization already in progress');
            return null;
        }

        this._initializationInProgress = true;
        
        try {
            // Check if MemoryRetriever is available
            if (typeof MemoryRetriever === 'undefined') {
                throw new Error('MemoryRetriever class not available');
            }

            // If no client is provided, initialize with limited functionality
            if (!client) {
                logger.warn('[MemoryManager] No Discord client provided, initializing with limited functionality');
                this._memoryRetriever = new MemoryRetriever({
                    ...this._defaultConfig,
                    ...customOptions
                });
                this._isInitialized = true;
                return this._memoryRetriever;
            }

            logger.info('[MemoryManager] Starting memory manager initialization...');
            
            // Reset state in case of re-initialization
            this._isInitialized = false;
            this._memoryRetriever = null;

            // Get priority channels from config or use default
            const defaultPriorityChannels = [
                global.MEMORY_CONFIG?.PRIORITY_CHANNEL_ID,
                '1362185428584890469' // Default priority channel
            ].filter(Boolean);

            if (defaultPriorityChannels.length === 0) {
                logger.warn('[MemoryManager] No priority channels configured. Memory loading may be limited.');
            }

            logger.debug('[MemoryManager] Initialization options:', {
                defaultPriorityChannels,
                customOptions: Object.keys(customOptions)
            });

            // Create and initialize the memory retriever
            this._memoryRetriever = new MemoryRetriever({
                ...this._defaultConfig,
                ...customOptions
            });

            // Set up background sync if enabled
            if (this._syncInterval) {
                const intervalMs = this._syncInterval;
                logger.info(`[MemoryManager] Setting up background memory sync every ${intervalMs}ms`);
                this._syncIntervalId = setInterval(
                    () => this.syncMemories(client, defaultPriorityChannels).catch(error => {
                        logger.error('[MemoryManager] Background sync failed:', error);
                    }),
                    intervalMs
                );
            }

            // Mark as initialized
            this._isInitialized = true;
            logger.info('[MemoryManager] Memory manager initialized successfully');
            
            return this._memoryRetriever;
            
        } catch (error) {
            logger.error('[MemoryManager] Failed to initialize memory manager:', error);
            // Clean up if initialization fails
            if (this._syncInterval) {
                clearInterval(this._syncInterval);
                this._syncInterval = null;
            }
            this._isInitialized = false;
            this._memoryRetriever = null;
            throw error;
        } finally {
            this._initializationInProgress = false;
        }
    }

    /**
     * Get the memory retriever instance
     * @returns {Object} Memory retriever instance
     */
    get memoryRetriever() {
        if (!this._memoryRetriever) {
            logger.warn('[MemoryManager] Memory retriever accessed before initialization');
            throw new Error('Memory retriever not initialized. Call initialize() first.');
        }
        return this._memoryRetriever;
    }

    /**
     * Check if the memory manager is initialized
     * @returns {boolean} True if initialized
     */
    get isInitialized() {
        return this._isInitialized && this._memoryRetriever !== null;
    }

    /**
     * Get the list of priority channel IDs
     * @returns {string[]} Array of channel IDs
     */
    get priorityChannelIds() {
        return this._defaultConfig.priorityChannelIds || [];
    }

    // Configuration management methods
    getDefaultConfig() {
        return { ...this._defaultConfig };
    }

    updateDefaultConfig(newConfig) {
        this._defaultConfig = { ...this._defaultConfig, ...newConfig };
        logger.info('[MemoryManager] Default configuration updated', newConfig);
    }

    async initializeFromHistory(client, options = {}) {
        if (!this._memoryRetriever) {
            throw new Error('Memory retriever not initialized. Call initialize() first.');
        }

        if (!client) {
            throw new Error('Discord client is required for initializing from history');
        }

        try {
            // Convert priority channels to an array if it's a single string
            const channelsToLoad = Array.isArray(priorityChannels) ? 
                priorityChannels : 
                (priorityChannels ? [priorityChannels] : []);

            // Initial memory load from priority channels
            if (channelsToLoad.length > 0) {
                logger.info(`[MemoryManager] Loading initial memories from ${channelsToLoad.length} priority channels`);
                await this.syncMemories(client, channelsToLoad);
            } else {
                logger.warn('[MemoryManager] No priority channels provided for memory initialization');
            }

            // Set up background sync if interval is greater than 0
            if (interval > 0) {
                this._syncInterval = setInterval(() => {
                    this.syncMemories(client, channelsToLoad).catch(error => {
                        logger.error('[MemoryManager] Background sync failed:', error);
                    });
                }, interval);
                logger.info(`[MemoryManager] Set up background memory sync every ${interval}ms`);
            }
        } catch (error) {
            logger.error('[MemoryManager] Failed to initialize memories from history:', error);
            // Don't rethrow the error to prevent bot from crashing
            // The bot can still function without historical memories
        }
    }
    
    async syncMemories(client, channelIds = []) {
        if (!this._memoryRetriever) {
            logger.warn('[MemoryManager] Cannot sync memories: memory retriever not initialized');
            if (this._isInitialized) {
                throw new Error('Memory retriever not initialized');
            }
            return; // Silently return if not initialized yet
        }
        
        if (this._initializationInProgress) {
            logger.debug('[MemoryManager] Skipping sync during initialization');
            return;
        }

        if (!client) {
            throw new Error('Discord client is required for memory sync');
        }

        try {
            // Get the current list of channel IDs to sync
            const channelsToSync = channelIds.length > 0 ? 
                channelIds : 
                (this._memoryRetriever.priorityChannelIds || []);
            
            if (channelsToSync.length === 0) {
                logger.warn('[MemoryManager] No channels to sync');
                return [];
            }

            logger.info(`[MemoryManager] Starting memory sync for ${channelsToSync.length} channels`);
            
            // Clear existing memories before syncing
            this._memoryRetriever.clearMemories();
            
            // Initialize memories from history
            const results = await this._memoryRetriever.initializeMemoriesFromHistory(
                client,
                channelsToSync,
                this._memoryRetriever.maxMemorySize
            );

            logger.info(`[MemoryManager] Memory sync completed. Processed ${results?.length || 0} messages.`);
            return results || [];
        } catch (error) {
            logger.error('[MemoryManager] Error during memory sync:', error);
            throw error;
        }
    }

    _setupBackgroundSync(client, priorityChannels, interval) {
        const backgroundMemorySync = async () => {
            try {
                if (!this._isInitialized || !this._memoryRetriever) {
                    logger.debug('[MemoryManager] Skipping background sync: not initialized yet');
                    return;
                }
                
                logger.debug('[MemoryManager] Running background memory sync');
                await this.loadRecentMessages(client, priorityChannels);
            } catch (error) {
                logger.error('[MemoryManager] Background memory sync failed:', error);
            } finally {
                // Schedule next sync only if initialized
                if (this._isInitialized && this._memoryRetriever) {
                    this._syncTimeout = setTimeout(backgroundMemorySync, interval);
                }
            }
        };

        // Start the background sync process only if initialized
        if (this._isInitialized && this._memoryRetriever) {
            this._syncTimeout = setTimeout(backgroundMemorySync, interval);
        } else {
            logger.debug('[MemoryManager] Delaying background sync until initialization is complete');
        }
    }

    // Memory store management methods
    clearMemoryStore() {
        if (this._memoryRetriever) {
            this._memoryRetriever.memoryStore = [];
            logger.info('[MemoryManager] Memory store cleared');
        }
    }

    getMemoryStoreSize() {
        return this._memoryRetriever ? this._memoryRetriever.memoryStore.length : 0;
    }
    
    // Cleanup method to be called when the bot shuts down
    async cleanup() {
        logger.info('[MemoryManager] Cleaning up memory manager...');
        
        // Clear any pending timeouts
        if (this._syncTimeout) {
            clearTimeout(this._syncTimeout);
            this._syncTimeout = null;
        }
        
        // Clear any intervals
        if (this._syncIntervalId) {
            clearInterval(this._syncIntervalId);
            this._syncIntervalId = null;
        }
        
        // Clear memory retriever if it exists
        if (this._memoryRetriever?.cleanup) {
            await this._memoryRetriever.cleanup();
        }
        
        this._isInitialized = false;
        this._initializationInProgress = false;
        this._syncInterval = null;
        logger.info('[MemoryManager] Cleanup completed');
    }

    async loadRecentMessages(client, priorityChannels) {
        if (!client) {
            logger.error('[MemoryManager] Cannot load messages: Discord client not available');
            return;
        }
        
        if (!this._memoryRetriever) {
            logger.warn('[MemoryManager] Cannot load messages: memory retriever not initialized');
            return;
        }

        for (const channelId of priorityChannels) {
            try {
                const channel = await client.channels.fetch(channelId);
                if (!channel) {
                    logger.warn(`[MemoryManager] Channel ${channelId} not found`);
                    continue;
                }
                
                // Fetch most recent messages (last 50)
                const messages = await channel.messages.fetch({ limit: 50 });
                
                // Add recent messages to memory
                messages.forEach(message => {
                    try {
                        this._memoryRetriever.addMemory(message.content, {
                            username: message.author?.username || 'unknown',
                            channelId: message.channel?.id || channelId,
                            timestamp: message.createdTimestamp || Date.now()
                        });
                    } catch (addError) {
                        logger.error(`[MemoryManager] Failed to add message to memory:`, addError);
                    }
                });

                logger.debug(`[MemoryManager] Processed ${messages.size} recent messages from channel ${channelId}`);
            } catch (error) {
                logger.error(`[MemoryManager] Failed to process channel ${channelId}:`, error);
            }
        }
    }
}

// Export the class with static getInstance method
module.exports = MemoryManager;

// Also export a singleton instance for convenience
module.exports.instance = MemoryManager.getInstance();