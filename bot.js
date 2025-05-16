require('dotenv').config();
const { Client, GatewayIntentBits, Events } = require('discord.js');
const logger = require('./utils/logger');
const generateRolybotResponse = require('./utils/rolybotResponse');
const { loadCommands, executeCommand } = require('./utils/commandLoader');
const { recordRolybotRequest, tooManyRolybotRequests, goAFK } = require('./utils/openaiHelper');
const { classifyMessage } = require('./utils/messageClassifier.js');
const gameManager = require('./utils/chess/gameManager');
const MemoryRetriever = require('./utils/memoryRetrieval');
const MemoryManager = require('./utils/memoryManager');

const COMMAND_PREFIX = process.env.COMMAND_PREFIX || '!rb';
const token = process.env.DISCORD_BOT_TOKEN;

// Memory Initialization Configuration
const MEMORY_CONFIG = {
    MAX_MEMORY_SIZE: 500,
    MEMORY_RATE_LIMIT: 1,
    SYNC_INTERVAL_MS: 1 * 1 * 1000, // 1 second
    PRIORITY_CHANNELS: [MemoryRetriever.DEFAULT_PRIORITY_CHANNEL_ID]
};

// Set global memory configuration for cross-module access
global.MEMORY_CONFIG = MEMORY_CONFIG;

// Global memory retriever managed by centralized manager

let rolybotBusy = false; // Only handle one prompt at a time
let rolybotAFK = false; // Don't respond if "AFK"
function setAFK(val) { rolybotAFK = val; }

if (!token) {
    logger.error('DISCORD_BOT_TOKEN is not defined. Exiting.');
    process.exit(1);
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// Log low‑level client warnings/errors
client.on('warn', info => logger.warn('Discord.js warning:', info));
client.on('error', err => logger.error('Discord.js error:', err));

// Global error handling
process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception:', error);
    // Attempt graceful shutdown
    try {
        client.destroy(); // Properly close Discord connection
    } catch (destroyErr) {
        logger.error('Error during client destruction:', destroyErr);
    }
    process.exit(1);
});

// Login to Discord with comprehensive error handling
const loginWithRetry = async (retries = 3) => {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            logger.info(`Attempting to log in to Discord (Attempt ${attempt}/${retries})`);
            
            // Validate token
            if (!token) {
                throw new Error('Discord bot token is missing or invalid');
            }

            await client.login(token);
            logger.info('Discord client login successful');
            return;
        } catch (err) {
            logger.error(`Discord client login failed (Attempt ${attempt}):`, err);
            
            if (attempt === retries) {
                logger.error('Max login attempts reached. Exiting.');
                process.exit(1);
            }
            
            // Wait before retrying
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
};

// Start the login process
loginWithRetry().catch(err => {
    logger.error('Critical error during Discord login:', err);
    process.exit(1);
});

// Load all !rb commands from /commands
loadCommands();

// Client ready event - initialize memories and set up message handling
client.once(Events.ClientReady, async () => {
    // Initialize global memory retriever via centralized manager
    const memoryRetriever = MemoryManager.initialize({
        priorityChannelIds: MEMORY_CONFIG.PRIORITY_CHANNELS,
        maxMemorySize: MEMORY_CONFIG.MAX_MEMORY_SIZE,
        memoryRateLimit: MEMORY_CONFIG.MEMORY_RATE_LIMIT
    });

    // Initialize memories from channel history
    try {
        // Initialize memories with background sync
        await MemoryManager.initializeFromHistory(client, {
            interval: MEMORY_CONFIG.SYNC_INTERVAL_MS,
            priorityChannels: MEMORY_CONFIG.PRIORITY_CHANNELS
        });
        
        logger.info('[Memory Initialization] Background memory synchronization started');
    } catch (error) {
        logger.error('[Memory Initialization] Failed to start background memory sync:', error);
    }
    logger.info(`Logged in as ${client.user.tag}`);
    
    // Memory initialization with comprehensive error handling
    const initializeMemories = async () => {
        logger.info('[Memory Initialization] Starting memory initialization process');
        
        try {
            // Validate client and memory retriever
            if (!client) {
                throw new Error('Discord client is not initialized');
            }
            
            if (!memoryRetriever) {
                throw new Error('Memory retriever is not initialized');
            }

            // Find the prioritized channel
            const priorityChannelId = MemoryRetriever.DEFAULT_PRIORITY_CHANNEL_ID;
            logger.info(`[Memory Initialization] Using priority channel ID: ${priorityChannelId}`);
            
            let channel;
            
            try {
                // Ensure we have the required intents
                if (!client.channels) {
                    throw new Error('Missing required Discord intents for channel access');
                }
                channel = await client.channels.fetch(priorityChannelId);
            } catch (fetchError) {
                logger.warn(`Could not fetch prioritized channel ${priorityChannelId}:`, fetchError);
            }
            
            if (channel) {
                logger.info(`Initializing memories from channel: ${channel.name}`);
                await MemoryManager.initializeFromHistory(client, [priorityChannelId]);
                logger.info(`Memory initialization complete. Total memories: ${MemoryManager.memoryRetriever.memoryStore.length}`);
            } else {
                logger.warn('Could not find prioritized channel for memory initialization');
            }

            // If no memories loaded, find a fallback channel
            if (MemoryManager.memoryRetriever.memoryStore.length === 0) {
                const fallbackChannel = client.channels.cache.find(
                    channel => channel.type === 0 // Text channel type
                );

                if (fallbackChannel) {
                    logger.info(`Initializing memories from fallback channel: ${fallbackChannel.name}`);
                    await MemoryManager.initializeFromHistory(client, [fallbackChannel.id]);
                } else {
                    logger.warn('No suitable channel found for memory initialization');
                }
            }
        } catch (error) {
            logger.error('Unexpected error during memory initialization:', error);
        }
    };

    // Set presence and start memory initialization
    client.user.setPresence({ status: 'online' });
    logger.info(`Bot is online as ${client.user.tag}`);

    // Run memory initialization without blocking the main thread
    initializeMemories()
        .then(() => {            
            // Ensure bot continues to function
            logger.info('[Memory Initialization] Memory initialization completed successfully');
        })
        .catch(err => {
            // Log detailed error information
            logger.error('Critical error in memory initialization:', err);
            logger.error('Error stack:', err.stack);
            
            // Fallback: attempt to continue bot operation
            logger.warn('Continuing bot operation with empty memory store');
            memoryRetriever.clearMemory(); // Ensure a clean state
        });
});

// Handle incoming messages
client.on(Events.MessageCreate, async message => {
    if (message.author.id === client.user.id) return; // Ignore self

    const content = message.content.trim();

    // Handle Commands (!rb)
    if (content.startsWith(COMMAND_PREFIX)) {
        const parts = content.slice(COMMAND_PREFIX.length).trim().split(/\s+/);
        const commandName = parts.shift().toLowerCase();
        try {
            await executeCommand(commandName, message, parts);
        } catch (err) {
            logger.error(`Error executing command "${commandName}":`, err);
            await message.reply('⚠️ Something went wrong running that command.');
        }
        return;
    }

    // Handle RolyBot responses
    // 1. If AFK, break.
    if (rolybotAFK) {
        logger.info("[RolyBot] AFK/rate limited - ignoring trigger.");
        return;
    }

    // 2. Run the classifier.
    let isReplyToBot = false;
    let repliedTo = null;
    if (message.reference?.messageId) {
        try {
            const original = await message.channel.messages.fetch(message.reference.messageId);
            if (original.author.id === client.user.id) {
                isReplyToBot = true;
                repliedTo = original;
            }
        } catch (err) {
            logger.warn("[RolyBot] could not fetch referenced message:", err);
        }
    }

    const classification = await classifyMessage(message.content);

    // Chess command handler (multi-intent)
    if (classification.chess_commands && Array.isArray(classification.chess_commands)) {
        const { startGame, resignGame, moveGame, showBoard } = require('./commands/chess');
        for (const cmd of classification.chess_commands) {
            if (cmd.command === 'start') {
                await startGame(message, message.author.id);
            } else if (cmd.command === 'resign') {
                await resignGame(message, message.author.id);
            } else if (cmd.command === 'move' && cmd.move) {
                await moveGame(message, [cmd.move], message.author.id);
            } else if (cmd.command === 'show') {
                await showBoard(message, message.author.id);
            }
        }
        return;
    }

    // 3. React with any emotes given by the classifier.
    if (classification.emotes && Array.isArray(classification.emotes)) {
        for (const emote of classification.emotes) {
            try {
                await message.react(emote);
            } catch (err) {
                logger.warn(`[RolyBot] Failed to react with ${emote}:`, err);
            }
        }
    }

    // 4. If direct reply to bot OR classifier says send a message, send the message.
    if (isReplyToBot || classification.message) {
        if (rolybotBusy) {
            logger.info("[RolyBot] currently busy - ignoring trigger.");
            return;
        }
        recordRolybotRequest();
        if (tooManyRolybotRequests()) {
            logger.info("[RolyBot] rate limited - ignoring trigger.");
            if (!rolybotAFK) {
                await goAFK(client, 60, message, setAFK);
            }
            return;
        }

        rolybotBusy = true;
        let typingInterval;
        try {
            await message.channel.sendTyping();
            typingInterval = setInterval(
                () => message.channel.sendTyping().catch(() => { }),
                1000
            );
            let msgContent = message.content;
            if (isReplyToBot && repliedTo) {
                msgContent = `In reply to: ${repliedTo.content}\n${msgContent}`;
            }
            const response = await generateRolybotResponse(client, message, repliedTo?.content);
            if (response && response.reply) await message.reply(response.reply);
        } catch (err) {
            logger.error("[RolyBot] generateRolybotResponse error:", err);
        } finally {
            clearInterval(typingInterval);
            rolybotBusy = false;
        }
    }
});