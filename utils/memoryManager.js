const logger = require('./logger');
const MemoryRetriever = require('./memoryRetrieval');

class MemoryManager {
    constructor() {
        this._memoryRetriever = null;
        this._defaultConfig = {
            priorityChannelIds: global.MEMORY_CONFIG?.PRIORITY_CHANNELS || [MemoryRetriever.DEFAULT_PRIORITY_CHANNEL_ID],
            maxMemorySize: global.MEMORY_CONFIG?.MAX_MEMORY_SIZE || 500,
            memoryRateLimit: global.MEMORY_CONFIG?.MEMORY_RATE_LIMIT || 60,
            memoryRateLimitWindow: 60000, // 1 minute
            preprocessingConfig: {
                tokenLimit: 500,
                embeddingDimension: 768,
                similarityThreshold: 0.7
            }
        };
    }

    initialize(customOptions = {}) {
        const options = { ...this._defaultConfig, ...customOptions };

        if (!this._memoryRetriever) {
            this._memoryRetriever = new MemoryRetriever(options);
            
            // Set in global scope for cross-module access
            global.memoryRetriever = this._memoryRetriever;
            
            logger.info('[MemoryManager] Memory retriever initialized with config', {
                maxMemorySize: options.maxMemorySize,
                memoryRateLimit: options.memoryRateLimit
            });
        }
        return this._memoryRetriever;
    }

    get memoryRetriever() {
        if (!this._memoryRetriever) {
            logger.warn('[MemoryManager] Memory retriever accessed before initialization');
            return this.initialize();
        }
        return this._memoryRetriever;
    }

    // Configuration management methods
    getDefaultConfig() {
        return { ...this._defaultConfig };
    }

    updateDefaultConfig(newConfig) {
        this._defaultConfig = { ...this._defaultConfig, ...newConfig };
        logger.info('[MemoryManager] Default configuration updated', newConfig);
    }

    // Optional: Add methods for centralized memory management
    async initializeFromHistory(client, options = {}) {
        if (!this._memoryRetriever) {
            this.initialize();
        }

        const {
            interval = 5 * 60 * 1000, // Default: every 5 minutes
            priorityChannels = [MemoryRetriever.DEFAULT_PRIORITY_CHANNEL_ID]
        } = options;

        // Initial historical memory load
        await this._memoryRetriever.initializeMemoriesFromHistory(client, priorityChannels);

        // Set up continuous background memory synchronization
        const backgroundMemorySync = async () => {
            try {
                //logger.info('[Memory Initialization] Starting background memory synchronization');
                
                // Fetch recent messages and add to memory
                await this.loadRecentMessages(client, priorityChannels);
                
                //logger.info('[Memory Initialization] Background memory sync completed');
            } catch (error) {
                logger.error('[Memory Initialization] Background memory sync failed:', error);
            } finally {
                // Schedule next sync
                setTimeout(backgroundMemorySync, interval);
            }
        };

        // Start the background sync process
        backgroundMemorySync();

        return this;
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

    async loadRecentMessages(client, priorityChannels) {
        for (const channelId of priorityChannels) {
            try {
                const channel = await client.channels.fetch(channelId);
                
                // Fetch most recent messages (last 50)
                const messages = await channel.messages.fetch({ limit: 50 });
                
                // Add recent messages to memory
                messages.forEach(message => {
                    this._memoryRetriever.addMemory(message.content, {
                        username: message.author.username,
                        channelId: message.channel.id,
                        timestamp: message.createdTimestamp
                    });
                });

                //.info(`[Memory Initialization] Processed ${messages.size} recent messages from channel ${channelId}`);
            } catch (error) {
                logger.error(`[Memory Initialization] Failed to process channel ${channelId}:`, error);
            }
        }
    }
}

module.exports = new MemoryManager();
