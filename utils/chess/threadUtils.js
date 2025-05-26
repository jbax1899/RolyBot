const { ThreadAutoArchiveDuration, ChannelType, PermissionsBitField } = require('discord.js');
const logger = require('../logger');

class ThreadUtils {
    constructor(gameStateManager, client) {
        this.gameStateManager = gameStateManager;
        this.client = client;
    }

    getThreadIdForUser(userId) {
        const game = this.gameStateManager.getGame(userId);
        return game?.threadId || null;
    }

    setThreadIdForUser(userId, threadId) {
        try {
            const game = this.gameStateManager.getGame(userId);
            if (game) {
                game.threadId = threadId;
                this.gameStateManager.saveGames();
            }
        } catch (e) {
            logger.error(`[ThreadUtils] Error setting thread ID: ${e.message}`);
            throw e;
        }
    }

    /**
     * Finds an existing thread for the given players if one exists
     * @param {Guild} guild - The Discord guild
     * @param {string} whiteId - White player's user ID
     * @param {string} blackId - Black player's user ID
     * @returns {Promise<ThreadChannel|null>} The existing thread or null if not found
     */
    async findExistingThread(guild, whiteId, blackId) {
        try {
            // Get user objects for both players
            const whiteUser = await this.client.users.fetch(whiteId);
            const blackUser = await this.client.users.fetch(blackId);
            
            // Generate the expected thread name
            const threadName = `♟️ ${whiteUser.username} vs ${blackUser.username}`.substring(0, 100);
            const altThreadName = `♟️ ${blackUser.username} vs ${whiteUser.username}`.substring(0, 100);
            
            // Search all text channels for existing threads
            const channels = guild.channels.cache.filter(c => 
                c.type === ChannelType.GuildText &&
                c.permissionsFor(guild.members.me).has(PermissionsBitField.Flags.ViewChannel)
            );
            
            for (const channel of channels.values()) {
                try {
                    // Fetch active threads in this channel
                    const threads = await channel.threads.fetchActive();
                    
                    // Check each thread
                    for (const thread of threads.threads.values()) {
                        if (thread.name === threadName || thread.name === altThreadName) {
                            logger.info(`[ThreadUtils] Found existing thread: ${thread.name} (${thread.id})`);
                            return thread;
                        }
                    }
                } catch (err) {
                    logger.error(`[ThreadUtils] Error searching threads in channel ${channel.name}:`, err);
                    continue;
                }
            }
            
            return null;
        } catch (error) {
            logger.error(`[ThreadUtils] Error finding existing thread: ${error.message}`);
            return null;
        }
    }

    /**
     * Creates a public thread for a chess match between two players in the current channel
     * @param {Client} client - Discord.js client
     * @param {Guild} guild - Discord.js guild
     * @param {string} whiteId - Discord.js user ID (white)
     * @param {string} blackId - Discord.js user ID (black)
     * @param {TextChannel} [channel] - Optional channel to create the thread in
     * @returns {Promise<ThreadChannel>} The created thread
     */
    async createGameThread(client, guild, whiteId, blackId, channel = null) {
        try {
            // First, check if a thread already exists for these players
            const existingThread = await this.findExistingThread(guild, whiteId, blackId);
            if (existingThread) {
                logger.info(`[ThreadUtils] Reusing existing thread: ${existingThread.name} (${existingThread.id})`);
                return existingThread;
            }

            // If no channel provided, find the first available text channel
            if (!channel) {
                channel = guild.channels.cache.find(c => 
                    c.type === ChannelType.GuildText && 
                    c.permissionsFor(guild.members.me).has(PermissionsBitField.Flags.SendMessages)
                );
                
                if (!channel) {
                    throw new Error('No suitable text channel found to create thread');
                }
            }

            // Get user objects for both players
            const whiteUser = await client.users.fetch(whiteId);
            const blackUser = await client.users.fetch(blackId);

            logger.info(`[ThreadUtils] Creating chess thread in channel: ${channel.name} (${channel.id})`);
            
            // Create a public thread directly in the current channel
            const thread = await channel.threads.create({
                name: `♟️ ${whiteUser.username} vs ${blackUser.username}`.substring(0, 100), // Ensure name is within Discord's 100 char limit
                autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
                type: ChannelType.PublicThread,
                reason: `Chess game between ${whiteUser.tag} and ${blackUser.tag}`
            });

            logger.info(`[ThreadUtils] Created thread ${thread.name} (${thread.id})`);

            // Add both players to the thread
            await Promise.all([
                thread.members.add(whiteId).catch(e => 
                    logger.error(`[ThreadUtils] Failed to add white player to thread: ${e.message}`)
                ),
                thread.members.add(blackId).catch(e => 
                    logger.error(`[ThreadUtils] Failed to add black player to thread: ${e.message}`)
                )
            ]);

            return thread;
        } catch (error) {
            logger.error(`[ThreadUtils] Error creating game thread: ${error.message}`);
            throw error;
        }
    }
}

let instance = null;

/**
 * Get or create the singleton instance of ThreadUtils
 * @param {Object} gameStateManager - The game state manager instance
 * @returns {ThreadUtils} The ThreadUtils instance
 */
function getInstance(gameStateManager, client) {
    if (!instance) {
        instance = new ThreadUtils(gameStateManager, client);
    } else if (client && !instance.client) {
        // Ensure client is set if not already
        instance.client = client;
    }
    return instance;
}

module.exports = {
    getInstance
};
