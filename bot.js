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
const MAX_REQUESTS = 10; // Max allowed in window
const WINDOW_SECONDS = 300; // Window duration (seconds)
const RATE_LIMIT_SECONDS = parseInt(process.env.RATE_LIMIT_SECONDS, 10) || 0; // after a request, how long until we can re-prompt
let rolybotBusy = false; // Only handle one prompt at a time
let rolybotAFK = false;
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

async function goAFK(client) {
    rolybotAFK = true;
    rolybotBusy = false;
    const AFK_MODEL = 'gpt-4o-mini';

    const prompt = `
    You are a Discord bot that has been activated too much in a short period of time, exceeding the rate limit.
    You are to generate a short, one-line message explaining that you are going AFK for a few minutes.
    `.trim();

    const response = await openai.responses.create({
        model: AFK_MODEL,
        input: prompt,
        temperature: 0.7
    });

    await message.reply(response);

    await generateValidStatus("You are going AFK for a little bit");

    await client.user.setPresence({ status: 'idle' });

    logger.warn('[RolyBot] Rate limit exceeded: Going AFK');
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
            await goAFK(client);

            // Wake up after RATE_LIMIT_SECONDS (fallback, or let USER command wake up)
            setTimeout(async () => {
                rolybotAFK = false;
                await client.user.setPresence({ status: 'online' });
                logger.info(`[RolyBot] AFK expired: resuming normal operation.`);
                // Clear timestamps so it doesn't immediately AFK again.
                requestTimestamps = [];
            }, RATE_LIMIT_SECONDS * 1000);
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
            const reply = await generateRolybotResponse(message);
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