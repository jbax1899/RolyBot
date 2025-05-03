require('dotenv').config();
const { Client, GatewayIntentBits, Events } = require('discord.js');
const logger = require('./utils/logger');
const generateRolybotResponse = require('./utils/rolybotResponse');
const { loadCommands, executeCommand } = require('./utils/commandLoader');
const { recordRolybotRequest, tooManyRolybotRequests, goAFK } = require('./utils/rateLimiter.js');

const COMMAND_PREFIX = process.env.COMMAND_PREFIX || '!rb';
const KEYWORD = "rolybot";
const token = process.env.DISCORD_BOT_TOKEN;

// Rate limiter config
let rolybotBusy = false; // Only handle one prompt at a time
let rolybotAFK = false; // Don't respond if "AFK"

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
            goAFK(60, message);
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
            rolybotBusy = false;
        }
    }
});