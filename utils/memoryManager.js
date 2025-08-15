const logger = require('./logger');
const MemoryRetriever = require('./memoryRetrieval');
const { Events } = require('discord.js');

class MemoryManager {
    // Private static instance variable
    static #instance = null;
    // Lock for thread safety during initialization
    static #initializing = false;

    /**
     * Get the singleton instance of MemoryManager
     * @returns {MemoryManager} The singleton instance
     */
    static getInstance() {
        if (!MemoryManager.#instance) {
            MemoryManager.#initializing = true;
            MemoryManager.#instance = new MemoryManager();
            MemoryManager.#initializing = false;
        }
        return MemoryManager.#instance;
    }

    /**
     * Private constructor to enforce singleton pattern
     * @private
     */
    constructor() {
        // Prevent direct construction calls with new operator
        if (MemoryManager.#instance && !MemoryManager.#initializing) {
            throw new Error('Use MemoryManager.getInstance() instead of new operator');
        }

        this._memoryRetriever = null;
        this._isInitialized = false;
        this._initializationInProgress = false;
        // Initialize with default values from global config
        this._defaultConfig = {
            priorityChannelIds: global.MEMORY_CONFIG?.PRIORITY_CHANNEL_ID ? [global.MEMORY_CONFIG.PRIORITY_CHANNEL_ID] : [],
            maxMemorySize: global.MEMORY_CONFIG?.MAX_MEMORY_SIZE || 500,
            memoryRateLimit: global.MEMORY_CONFIG?.MEMORY_RATE_LIMIT || 60,
            memoryRateLimitWindow: 1000, //ms
            preprocessingConfig: {
                tokenLimit: 500,
                embeddingDimension: 768,
                similarityThreshold: 0.7
            }
        };

        MemoryManager.instance = this;
    }

    /**
     * Get the memory retriever instance
     * @returns {MemoryRetriever} The memory retriever instance
     */
    get memoryRetriever() {
        if (!this._memoryRetriever) {
            throw new Error('Memory retriever not initialized. Call initialize() first.');
        }
        return this._memoryRetriever;
    }

    async initialize(client, customOptions = {}) {
        // Validate client and options
        if (!client) {
            const error = new Error('Discord client is required for memory manager initialization');
            logger.error('[MemoryManager] Initialization failed:', error);
            throw error;
        }

        if (this._isInitialized) {
            logger.info('[MemoryManager] Memory manager already initialized');
            return this._memoryRetriever;
        }

        logger.info('[MemoryManager] Starting memory manager initialization...');
        this._isInitialized = false; // Ensure we're marked as not initialized until complete
        this._memoryRetriever = null; // Reset memory retriever
        this._initializationInProgress = true; // Mark initialization as in progress

        try {
            // Set up default priority channels if none provided
            const defaultPriorityChannels = [
                global.MEMORY_CONFIG?.PRIORITY_CHANNEL_ID,
                ...(customOptions.priorityChannelIds || [])
            ].filter(Boolean); // Remove any undefined/null values

            if (defaultPriorityChannels.length === 0) {
                logger.warn('[MemoryManager] No priority channels configured. Memory loading may be limited.');
            }

            const options = { 
                ...this._defaultConfig, 
                ...customOptions,
                priorityChannelIds: defaultPriorityChannels,
                client // Pass the client to the retriever
            };
            
            logger.debug('[MemoryManager] Initialization options:', {
                maxMemorySize: options.maxMemorySize,
                memoryRateLimit: options.memoryRateLimit,
                syncInterval: options.syncInterval,
                priorityChannelCount: options.priorityChannelIds?.length || 0
            });

            logger.info('[MemoryManager] Initializing memory manager with options:', {
                priorityChannels: defaultPriorityChannels,
                maxMemorySize: options.maxMemorySize,
                memoryRateLimit: options.memoryRateLimit
            });

            // Initialize memory retriever with client
            this._memoryRetriever = new MemoryRetriever({
                ...options,
                client // Pass the client to the retriever
            });
            
            if (!this._memoryRetriever) {
                throw new Error('Failed to create memory retriever instance');
            }
            
            global.memoryRetriever = this._memoryRetriever;
            logger.debug('[MemoryManager] Memory retriever instance created');

            // Set up periodic sync if enabled
            if (options.syncInterval > 0) {
                // Don't start the sync immediately, it will be started after initialization is complete
                this._syncInterval = options.syncInterval;
                logger.info(`[MemoryManager] Will set up memory sync every ${options.syncInterval}ms after initialization`);
            }

            // Initial memory sync
            try {
                await this.syncMemories(client, defaultPriorityChannels);
                logger.debug('[MemoryManager] Initial memory sync completed successfully');
            } catch (syncError) {
                logger.warn('[MemoryManager] Initial memory sync failed, but continuing with initialization:', syncError);
                // Continue with initialization even if sync fails
            }

            this._isInitialized = true;
            logger.info('[MemoryManager] Memory manager initialized successfully');
            
            if (!this._memoryRetriever) {
                throw new Error('Memory retriever is not available after initialization');
            }
            
            // Perform initial sync after initialization is complete
            try {
                logger.info('[MemoryManager] Starting initial memory sync...');
                await this.syncMemories(client, defaultPriorityChannels);
                logger.info('[MemoryManager] Initial memory sync completed successfully');
            } catch (syncError) {
                logger.warn('[MemoryManager] Initial memory sync failed, but continuing with initialization:', syncError);
                // Continue with initialization even if sync fails
            }
            
            // Set up background sync if enabled (now that we're fully initialized)
            if (this._syncInterval && !this._syncIntervalId) {
                const intervalMs = this._syncInterval;
                logger.info(`[MemoryManager] Setting up background memory sync every ${intervalMs}ms`);
                this._syncIntervalId = setInterval(
                    () => this.syncMemories(client, defaultPriorityChannels).catch(error => {
                        logger.error('[MemoryManager] Background sync failed:', error);
                    }),
                    intervalMs
                );
            }
            
            this._initializationInProgress = false; // Mark initialization as complete
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

// Export the class for direct instantiation if needed
module.exports = MemoryManager;

// Also export the singleton instance for convenience
module.exports.instance = MemoryManager.getInstance();