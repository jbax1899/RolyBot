const { ThreadAutoArchiveDuration, ChannelType, PermissionsBitField, VoiceChannel } = require('discord.js');
const logger = require('../logger');
const threadUtils = require('./threadUtils');

// This will be set by the game manager to avoid circular dependencies
let threadUtilsInstance = null;
let clientInstance = null;

function setThreadUtils(instance) {
    threadUtilsInstance = instance;
}

function setClient(client) {
    if (threadUtilsInstance && !threadUtilsInstance.client) {
        threadUtilsInstance.client = client;
    }
}

/**
 * Ensures a private chess thread for the user exists and returns it.
 * If not, creates a new private thread in the current channel.
 * @param {Client} client
 * @param {Message} message
 * @param {string} userId
 * @returns {Promise<ThreadChannel>} The thread
 */

async function ensureGameThread(client, message, userId) {
    let threadId = getThreadIdForUser(userId);
    let thread = null;

    // 1. If the message is in a thread, use it if valid
    if (!message.channel) {
        logger.error(`[ERROR] message or message.channel is undefined in ensureGameThread.
            Message: ${JSON.stringify(message)}
            Stack:
            ${new Error().stack}`);
    }
    if (message.channel.isThread && typeof message.channel.isThread === 'function' && message.channel.isThread()) {
        thread = message.channel;
        if (thread.type === ChannelType.PublicThread && typeof thread.send === 'function') {
            // Save mapping if not already mapped
            if (!threadId || threadId !== thread.id) {
                setThreadIdForUser(userId, thread.id);
            }
            return thread;
        }
        // If not valid, fall through to create new in parent
    }

    // 2. If no valid thread mapping, create a new one in the parent or current channel
    if (!threadId) {
        // Use parent channel if in a thread, otherwise use current channel
        let baseChannel;
        if (!message.channel) {
            logger.error('[ERROR] message.channel is undefined when creating a new thread.');
            throw new Error('Cannot determine channel context: message.channel is undefined.');
        }
        if (message.channel.isThread && typeof message.channel.isThread === 'function' && message.channel.isThread() && message.channel.parent) {
            baseChannel = message.channel.parent;
        } else {
            baseChannel = message.channel;
        }
        if (!baseChannel.threads || baseChannel.type !== ChannelType.GuildText) {
            throw new Error('Cannot create a thread: Command must be run in a server text channel.');
        }
        try {
            thread = await baseChannel.threads.create({
                name: `♟️ Chess vs ${message.author.username}`,
                autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
                type: ChannelType.PublicThread,
                reason: `Chess game for ${message.author.tag}`
            });
            setThreadIdForUser(userId, thread.id);
            threadId = thread.id;
        } catch (e) {
            if (e.code === 50013 || (e.message && e.message.includes('Missing Access'))) {
                logger.error('[ERROR] Missing Access: The bot does not have permission to create threads or add members.');
            } else {
                logger.error('[ERROR] Exception creating thread:', e);
            }
            throw e;
        }
    }

    // 3. Try to fetch and validate the thread
    try {
        thread = await client.channels.fetch(threadId);
        if (!thread) {
            logger.error(`[ERROR] Thread with ID ${threadId} could not be fetched (undefined).`);
            throw new Error('Thread could not be fetched or does not exist.');
        }
        if (
            !thread.isThread ||
            typeof thread.isThread !== 'function' ||
            !thread.isThread() ||
            typeof thread.send !== 'function' ||
            thread.type !== ChannelType.PublicThread
        ) {
            logger.error(`[ERROR] Fetched object for threadId ${threadId} is not a valid public thread.`);
            throw new Error('Fetched object is not a valid public thread');
        }
    } catch (e) {
        logger.error('[ERROR] Exception fetching or validating thread - ', e);
        throw e;
    }
    return thread;
}

/**
 * If the original message was sent outside the game thread, reply in the original channel with a link to the bot's response in the game thread.
 * @param {Message} originalMessage - The original Discord.js message
 * @param {ThreadChannel} thread - The thread where the bot responded
 * @param {Message} threadResponse - The bot's message in the thread
 */
async function replyWithThreadLink(originalMessage, thread, threadResponse) {
    try {
        if (originalMessage.channel.id !== thread.id) {
            // Construct message link
            const guildId = thread.guildId || thread.guild.id;
            const channelId = thread.id;
            const messageId = threadResponse.id;
            const link = `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
            await originalMessage.channel.send(`I've responded in your game thread: ${link}`);
        }
    } catch (err) {
        logger.error('[replyWithThreadLink] Failed to send thread link:', err);
    }
}

/**
 * Creates a public thread for a chess match between two players in the current channel.
 * @param {Client} client - Discord.js client
 * @param {Guild} guild - Discord.js guild
 * @param {string} whiteId - Discord.js user ID (white)
 * @param {string} blackId - Discord.js user ID (black)
 * @param {TextChannel} [channel] - Optional channel to create the thread in. If not provided, will use the first available text channel.
 * @returns {Promise<ThreadChannel>} The created thread
 */
async function createGameThread(client, guild, whiteId, blackId, channel = null) {
    try {
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

        logger.info(`[ThreadManager] Creating chess thread in channel: ${channel.name} (${channel.id})`);
        
        // Create thread with both players' usernames
        const thread = await channel.threads.create({
            name: `♟️ ${whiteUser.username} vs ${blackUser.username}`.substring(0, 100), // Ensure name is within Discord's 100 char limit
            autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
            type: ChannelType.PublicThread,
            reason: `Chess game between ${whiteUser.tag} and ${blackUser.tag}`
        });

        logger.info(`[ThreadManager] Created thread ${thread.name} (${thread.id})`);

        // Add both players to the thread
        await Promise.all([
            thread.members.add(whiteId).catch(e => 
                logger.error(`[ThreadManager] Failed to add white player to thread: ${e.message}`)
            ),
            thread.members.add(blackId).catch(e => 
                logger.error(`[ThreadManager] Failed to add black player to thread: ${e.message}`)
            )
        ]);

        // Store thread mappings for both players
        setThreadIdForUser(whiteId, thread.id);
        setThreadIdForUser(blackId, thread.id);

        return thread;
    } catch (error) {
        logger.error(`[ThreadManager] Error creating game thread: ${error.message}`, error);
        throw error;
    }
}

// Add function to release voice channel when a game ends
function releaseVoiceChannel(threadId) {
    const threads = loadThreads();
    if (threads[threadId] && threads[threadId].voiceChannelId) {
        delete threads[threadId].voiceChannelId;
        saveThreads(threads);
        return true;
    }
    return false;
}

async function setupVoiceChannel(thread, guild) {
    try {
        const threads = loadThreads();
        // Check if any game is currently using voice chat
        const activeVoiceChannel = Object.values(threads).find(t => t.voiceChannelId);
        if (activeVoiceChannel) {
            return null; // Voice chat is in use
        }

        // Find an available voice channel
        const availableChannel = guild.channels.cache.find(
            c => c.type === 2 && // GuildVoice
            !Object.values(threads).some(t => t.voiceChannelId === c.id)
        );

        if (!availableChannel) {
            return null; // No available channels
        }

        // Set up permissions
        await availableChannel.permissionOverwrites.edit(guild.roles.everyone, {
            ViewChannel: true,
            Connect: true,
            Speak: true
        });

        // Join the channel
        const connection = await availableChannel.join();
        if (!connection) {
            throw new Error('Failed to join voice channel');
        }

        // Claim the channel
        claimVoiceChannel(thread.id, availableChannel.id);
        return availableChannel;
    } catch (error) {
        logger.error(`[ThreadManager] Error setting up voice channel: ${error.message}`);
        return null;
    }
}

function claimVoiceChannel(threadId, voiceChannelId) {
    const threads = loadThreads();
    threads[threadId] = { ...threads[threadId], voiceChannelId };
    saveThreads(threads);
}

// Export functions
module.exports = {
    setThreadUtils,
    setClient,
    getThreadIdForUser: (userId) => threadUtilsInstance?.getThreadIdForUser(userId) || null,
    setThreadIdForUser: (userId, threadId) => threadUtilsInstance?.setThreadIdForUser(userId, threadId),
    ensureGameThread,
    replyWithThreadLink,
    createGameThread: async (client, guild, whiteId, blackId, channel = null) => {
        if (!threadUtilsInstance) {
            throw new Error('ThreadUtils not initialized. Call setThreadUtils first.');
        }
        return threadUtilsInstance.createGameThread(client, guild, whiteId, blackId, channel);
    },
    setupVoiceChannel,
    releaseVoiceChannel
};