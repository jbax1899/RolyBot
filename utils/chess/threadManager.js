const fs = require('fs');
const path = require('path');
const { ThreadAutoArchiveDuration, ChannelType } = require('discord.js');
const logger = require('../logger');

const THREADS_PATH = path.join(__dirname, 'gameThreads.json');

function loadThreads() {
    if (!fs.existsSync(THREADS_PATH)) return {};
    try {
        return JSON.parse(fs.readFileSync(THREADS_PATH, 'utf8'));
    } catch (err) {
        return {};
    }
}

function saveThreads(threads) {
    fs.writeFileSync(THREADS_PATH, JSON.stringify(threads, null, 2));
}

function getThreadIdForUser(userId) {
    const threads = loadThreads();
    return threads[userId] || null;
}

function setThreadIdForUser(userId, threadId) {
    const threads = loadThreads();
    threads[userId] = threadId;
    saveThreads(threads);
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

module.exports = {
    getThreadIdForUser,
    setThreadIdForUser,
    ensureGameThread,
    replyWithThreadLink
};