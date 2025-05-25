const { ThreadAutoArchiveDuration, ChannelType, PermissionsBitField } = require('discord.js');
const logger = require('../logger');

class ThreadUtils {
    constructor(gameStateManager) {
        this.gameStateManager = gameStateManager;
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

    async createGameThread(client, guild, whiteId, blackId) {
        try {
            // Find or create a chess category
            let category = guild.channels.cache.find(
                c => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === 'chess games'
            );

            if (!category) {
                category = await guild.channels.create({
                    name: 'Chess Games',
                    type: ChannelType.GuildCategory,
                    permissionOverwrites: [
                        {
                            id: guild.roles.everyone,
                            deny: [PermissionsBitField.Flags.SendMessages],
                            allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory]
                        }
                    ]
                });
            }

            // Create a text channel for the game
            const channel = await guild.channels.create({
                name: `chess-${whiteId.slice(-4)}-vs-${blackId.slice(-4)}`,
                type: ChannelType.GuildText,
                parent: category,
                permissionOverwrites: [
                    {
                        id: guild.roles.everyone,
                        deny: [PermissionsBitField.Flags.SendMessages],
                        allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory]
                    },
                    {
                        id: whiteId,
                        allow: [
                            PermissionsBitField.Flags.SendMessages,
                            PermissionsBitField.Flags.ViewChannel,
                            PermissionsBitField.Flags.ReadMessageHistory
                        ]
                    },
                    {
                        id: blackId,
                        allow: [
                            PermissionsBitField.Flags.SendMessages,
                            PermissionsBitField.Flags.ViewChannel,
                            PermissionsBitField.Flags.ReadMessageHistory
                        ]
                    }
                ]
            });


            // Create a thread in the channel
            const thread = await channel.threads.create({
                name: `Chess Game: ${whiteId.slice(-4)} vs ${blackId.slice(-4)}`,
                autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
                reason: 'Chess game thread',
                type: ChannelType.PrivateThread
            });

            // Add players to the thread
            await thread.members.add(whiteId);
            await thread.members.add(blackId);

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
function getInstance(gameStateManager) {
    if (!instance) {
        instance = new ThreadUtils(gameStateManager);
    }
    return instance;
}

module.exports = {
    getInstance
};
