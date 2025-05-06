require('dotenv').config();
const { Client, GatewayIntentBits, Events } = require('discord.js');
const logger = require('./utils/logger');
const generateRolybotResponse = require('./utils/rolybotResponse');
const { loadCommands, executeCommand } = require('./utils/commandLoader');
const { recordRolybotRequest, tooManyRolybotRequests, goAFK } = require('./utils/openaiHelper');
const { classifyMessage } = require('./utils/messageClassifier');

const COMMAND_PREFIX = process.env.COMMAND_PREFIX || '!rb';
const token = process.env.DISCORD_BOT_TOKEN;

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

    const classification = await classifyMessage(message);

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
            const reply = await generateRolybotResponse(client, message, repliedTo?.content);
            if (reply) await message.reply(reply);
        } catch (err) {
            logger.error("[RolyBot] generateRolybotResponse error:", err);
        } finally {
            clearInterval(typingInterval);
            rolybotBusy = false;
        }
    }
});