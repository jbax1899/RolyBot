/**
 * Main entry point for RolyBot:
 *  - Loads environment variables from .env (DISCORD_BOT_TOKEN, COMMAND_PREFIX, etc.)
 *  - Initializes Discord.js client with necessary intents (Guilds, GuildMessages, MessageContent)
 *  - Hooks in structured logging for warnings/errors
 *  - Loads and dispatches text commands under the COMMAND_PREFIX (default “!rb”)
 *  - Listens for keyword (“rolybot”), direct mentions, or replies to the bot to trigger AI responses
 *  - Wraps OpenAI calls for conversational replies, with a typing indicator
 *  - Enforces rate limits (MAX_REQUESTS per WINDOW_SECONDS) and toggles AFK/idle mode on overuse
 *  - Manages a busy flag to serialize in-flight prompts and a cooldown timer
 */

require('dotenv').config();
const { Client, GatewayIntentBits, Events } = require('discord.js');
const logger = require('./utils/logger');
const generateRolybotResponse = require('./utils/rolybotResponse');
const { loadCommands, executeCommand } = require('./utils/commandLoader');
const { generateValidStatus } = require("./utils/openaiHelper");

const COMMAND_PREFIX = process.env.COMMAND_PREFIX || '!rb';
const KEYWORD = "rolybot";
const token = process.env.DISCORD_BOT_TOKEN;

// Rate limiter config
const MAX_REQUESTS = 20; // Max allowed in window
const WINDOW_SECONDS = 300; // Window duration (seconds)
const RATE_LIMIT_SECONDS = parseInt(process.env.RATE_LIMIT_SECONDS, 10) || 0;
const MAX_AFK_DURATION = parseInt(process.env.MAX_AFK_DURATION, 10) || 300; // Max AFK duration (seconds)
let rolybotBusy = false; // Only handle one prompt at a time
let rolybotAFK = false; // Don't respond if "AFK"
let requestTimestamps = [];

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

// Load all !rb commands from /commands
loadCommands();

// Login to Discord
client.login(token)
    .then(() => logger.info('Discord client login successful'))
    .catch(err => {
        logger.error('Discord client login failed:', err);
        process.exit(1);
    });

// Set presence once ready
client.once(Events.ClientReady, () => {
    client.user.setPresence({ status: 'online' });
    logger.info(`Bot is online as ${client.user.tag}`);
});

function recordRolybotRequest() {
    const now = Date.now();
    requestTimestamps.push(now);
    // Only keep requests in WINDOW_SECONDS seconds
    requestTimestamps = requestTimestamps.filter(
        ts => now - ts < WINDOW_SECONDS * 1000
    );
}

function tooManyRolybotRequests() {
    const now = Date.now();
    // Only count recent requests in WINDOW_SECONDS seconds
    const recent = requestTimestamps.filter(
        ts => now - ts < WINDOW_SECONDS * 1000
    );
    return recent.length > MAX_REQUESTS;
}

/**
 * goAFK()
 *   - duration: seconds to remain AFK
 *   - message:  the Message that triggered the AFK
 */
async function goAFK(duration = RATE_LIMIT_SECONDS, message) {
    rolybotAFK = true;
    rolybotBusy = false;
    
    if (duration > MAX_AFK_DURATION) {
        duration = MAX_AFK_DURATION;
        logger.warn(`[RolyBot] AFK duration limited to ${MAX_AFK_DURATION}s`);
    }

    logger.info(`[RolyBot] Going AFK for ${duration}s`);

    // Schedule the wake-up
    setTimeout(async () => {
        rolybotAFK = false;
        requestTimestamps = []; // clear rate limiter
        await client.user.setPresence({ status: 'online' });
        logger.info(`[RolyBot] AFK expired — back online`);
    }, duration * 1000);

    if (message) {
        // Generate a one-line “I’m going AFK” reply
        const afkNotice = await generateRolybotResponse({
            content: `You are a Discord bot that needs to take a ${duration}-second break. Generate one short line explaining you're going AFK.
                        You are replying to this message: ${message}`
        });

        await message.reply(afkNotice || "I'm going AFK for a bit. Be back soon!");
    }

    // Set presence to idle
    client.user.setPresence({ status: 'idle' });  
}

// Handle incoming messages
client.on(Events.MessageCreate, async message => {
    if (message.author.id === client.user.id) return;

    const content = message.content.trim();
    const lower = content.toLowerCase();

    // 1) Command dispatch (!rb)
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

    // 2) Trigger RolyBot on keyword/mention/reply
    const hasKeyword = lower.includes(KEYWORD);
    const isMentioned = message.mentions.users.has(client.user.id);

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

    if (hasKeyword || isMentioned || isReplyToBot) {
        if (rolybotAFK) {
            logger.info("[RolyBot] AFK/rate limited - ignoring trigger.");
            return;
        }

        recordRolybotRequest();
        if (tooManyRolybotRequests()) {
            await goAFK(60, message);
            return;
        }

        if (rolybotBusy) {
            logger.info("[RolyBot] currently busy - ignoring trigger.");
            return;
        }
        rolybotBusy = true;

        let typingInterval;
        try {
            await message.channel.sendTyping();
            typingInterval = setInterval(
                () => message.channel.sendTyping().catch(() => { }),
                3000
            );

            if (isReplyToBot && repliedTo) {
                message.content =
                    `In reply to: ${repliedTo.content}\n` +
                    message.content;
            }
            const reply = await generateRolybotResponse(message, repliedTo?.content);
            if (reply) await message.reply(reply);
        } catch (err) {
            logger.error("[RolyBot] generateRolybotResponse error:", err);
        } finally {
            clearInterval(typingInterval);
            setTimeout(() => {
                rolybotBusy = false;
                logger.info(`[RolyBot] cooldown expired, ready for next trigger.`);
            }, RATE_LIMIT_SECONDS * 1000);
        }
    }
});