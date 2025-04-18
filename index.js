require('dotenv').config(); // only needed for local development
const { performance } = require('perf_hooks');
const fs = require('fs');
const path = require('path');

// Logging
// Override default console methods
console.log = createLogger(console.log, 'LOG');
console.warn = createLogger(console.warn, 'WARN');
console.error = createLogger(console.error, 'ERROR');
const logPath = path.join(__dirname, 'log.txt');

function createLogger(originalFn, label) {
    return function (...args) {
        const timestamp = new Date().toISOString();
        const message = args.map(arg => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ');
        const fullMessage = `[${timestamp}] [${label}] ${message}\n`;

        // Write to log file
        fs.appendFileSync(logPath, fullMessage);

        // Also write to the original console method
        originalFn.apply(console, args);
    };
}

// Discord
const { Client, GatewayIntentBits, EmbedBuilder, Events, TextChannel, PermissionsBitField } = require('discord.js');
const client = new Client({ intents: [
    GatewayIntentBits.Guilds, 
    GatewayIntentBits.MessageContent, 
    GatewayIntentBits.GuildMessages] });

const token = process.env.DISCORD_BOT_TOKEN;
const COMMAND_PREFIX = '!rb';    

// OpenAI
const OpenAI = require("openai");
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// Bot Knowledge
const conversationMemory = new Map();
const MAX_HISTORY = 10;
let lastUsage = null;

// Bot Commands
const commands = {
    'help': {
        description: 'Displays this help message.',
        execute: (message, args) => {
            const embed = new EmbedBuilder()
                .setTitle('===Help Page===')
                .setColor(0x00FF00)
                .setDescription(Object.entries(commands)
                    .map(([name, cmd]) => `${COMMAND_PREFIX} ${name} – ${cmd.description}`)
                    .join('\n'));
            message.channel.send({ embeds: [embed] });
        }
    },
    'status': {
        description: 'Generates and sets a new status for the bot.',
        execute: async (message, args) => {
            const typeMap = {
                'Playing': 0,
                'Streaming': 1,
                'Listening': 2,
                'Watching': 3
            };
            const typeList = Object.keys(typeMap);
            
            try {
                const { typeWord, activity, type, rawStatus, response } =
                    await generateValidStatus(openai, typeMap, typeList);
            
                await client.user.setPresence({
                    activities: [{
                        name: activity,
                        type: type
                    }],
                    status: 'online'
                });
            
                console.log(`Status updated to: "${typeWord} ${activity}"`);
                message.channel.send(`✅ Status updated to: **${typeWord} ${activity}**`);
            
                const usage = response.usage;
                if (usage) {
                    lastUsage = usage;

                    const inputTokens = usage.prompt_tokens || 0;
                    const outputTokens = usage.completion_tokens || 0;
                    const totalTokens = usage.total_tokens || 0;

                    const inputCost = (inputTokens / 1000) * 0.0015;
                    const outputCost = (outputTokens / 1000) * 0.0020;
                    const totalCost = inputCost + outputCost;

                    console.log(`Tokens used - Input: ${inputTokens}, Output: ${outputTokens}, Total: ${totalTokens}`);
                    console.log(`Estimated cost: $${totalCost.toFixed(6)} (Input: $${inputCost.toFixed(6)}, Output: $${outputCost.toFixed(6)})`);
                } else {
                    console.log('⚠️ Token usage data not available in response.');
                }
            } catch (error) {
                console.error('Error setting status:', error);
                message.channel.send('⚠️ An error occurred while updating the status.');
            }            
        }
    },
    'debug': {
        description: 'Shows bot diagnostics and last OpenAI usage stats.',
        execute: async (message, args) => {
            const uptimeSec = Math.floor(process.uptime());
            const memoryUsage = process.memoryUsage();

            const lines = [
                `⏱️ Uptime: ${uptimeSec}s`,
                `💾 Memory: ${(memoryUsage.rss / 1024 / 1024).toFixed(2)} MB RSS`,
                `🧠 Heap Used: ${(memoryUsage.heapUsed / 1024 / 1024).toFixed(2)} MB`,
            ];

            if (lastUsage) {
                const inputTokens = lastUsage.prompt_tokens || 0;
                const outputTokens = lastUsage.completion_tokens || 0;
                const totalTokens = lastUsage.total_tokens || 0;

                lines.push(
                    '',
                    `📊 Last OpenAI Usage:`,
                    `• Prompt: ${inputTokens} tokens`,
                    `• Completion: ${outputTokens} tokens`,
                    `• Total: ${totalTokens} tokens`
                );
            } else {
                lines.push('', '📊 No OpenAI usage recorded yet.');
            }

            const embed = new EmbedBuilder()
                .setTitle('🛠️ Bot Debug Info')
                .setColor(0x3498db)
                .setDescription(lines.join('\n'));

            await message.channel.send({ embeds: [embed] });
        }
    }
};

// Bot login
// Find your token under Bot, Token. https://discordapp.com/developers/applications/me
// WARNING: Do not commit your token to git! Use an environment variable instead!
if (!token) {
    console.error('DISCORD_BOT_TOKEN is not defined!');
    process.exit(1);
} else {
    console.log('Token loaded from environment variable');
    client.login(token);
}

client.once('ready', async () => {
    console.log('Bot is online!');
    
    // Loop through all guilds the bot is a part of
    client.guilds.cache.forEach(async (guild) => {
        try {
            // Fetch all channels in this guild
            const channels = await guild.channels.fetch();
            
            // Loop through each channel and check if it's a text channel
            channels.forEach(async (channel) => {
                // Check if the channel is an instance of TextChannel
                if (channel instanceof TextChannel) {
                    // Ensure the bot has both VIEW_CHANNEL and READ_MESSAGE_HISTORY permissions
                    if (channel.permissionsFor(client.user)?.has([PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory])) {
                        try {
                            // Ensure the channel.id exists before calling the function
                            if (channel.id) {
                                await loadConversationHistory(channel.id);
                                console.log(`Successfully fetched messages from channel ${channel.name}`);
                            }
                        } catch (err) {
                            console.error(`Error fetching messages from channel ${channel.name} (${channel.id}):`, err);
                        }
                    } else {
                        console.log(`Skipping channel ${channel.name} (${channel.id}) due to lack of access.`);
                    }
                }
            });
        } catch (error) {
            console.error(`Error fetching channels for guild ${guild.id}:`, error);
        }
    });

    client.user.setPresence({ status: 'online' });
    console.log('Bot is online!');
});

// Listens for commands
client.on(Events.MessageCreate, async message => {
    // Ignore messages from the bot itself
    if (message.author.id === client.user.id) return;

    // Check for RolyBot keyword and respond
    const rolyReply = await generateRolybotResponse(message);
    if (rolyReply) {
        await message.channel.send(rolyReply);
        return;
    }

    // Continue processing if the message doesn't start with "hey rolybot"
    if (!message.content.startsWith(COMMAND_PREFIX)) return;

    const args = message.content.slice(COMMAND_PREFIX.length).trim().split(/ +/);
    const commandName = args.shift().toLowerCase();

    const command = commands[commandName];
    if (!command) {
        message.channel.send(`Unknown command: \`${commandName}\``);
        return;
    }

    console.log(`EXECUTE COMMAND: "${commandName}" from user "${message.author.username}" (ID: ${message.author.id})`);

    const start = performance.now();
    try {
        await command.execute(message, args);
    } catch (err) {
        console.error(`❌ Error executing command "${commandName}":`, err);
    }
    const duration = performance.now() - start;
    console.log(`⏱️ "${commandName}" completed (${duration.toFixed(2)} ms)`);
});

async function generateValidStatus(openai, typeMap, typeList, maxAttempts = 3) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const randomType = typeList[Math.floor(Math.random() * typeList.length)];

        const prompt = `You are a Discord bot that generates funny statuses, one short sentence with the format "<type> <activity>" (without the quotes), where type is ${randomType}.
        For example: "Listening to my music playlist"
        Do not include quotes, markdown, links, hashtags, mentions, or formatting.
        Keep it clean-ish and funny.
        Target audience: 20s-30s, tech-savvy, enjoys memes and pop culture references.
        Ensure it is a complete sentence less than 50 characters.`;

        const response = await openai.completions.create({
            model: 'gpt-3.5-turbo-instruct',
            prompt: prompt,
            temperature: 0.7,
            max_tokens: 32
        });

        let rawStatus = response.choices[0].text.trim();
        rawStatus = rawStatus.replace(/^["“”']|["“”']$/g, '').trim();

        if (rawStatus.length > 50) {
            console.warn(`❌ Attempt ${attempt}: Rejected status (too long): "${rawStatus}"`);
            continue;
        }

        const [typeWord, ...activityParts] = rawStatus.split(' ');
        const activity = activityParts.join(' ');
        const type = typeMap[typeWord];

        if (type === undefined || !activity) {
            console.warn(`❌ Attempt ${attempt}: Malformed status "${rawStatus}"`);
            continue;
        }

        const usage = response.usage || {};
        const prompt_tokens = usage.prompt_tokens || 0;
        const completion_tokens = usage.completion_tokens || 0;
        const total_tokens = usage.total_tokens || 0;

        return {
            typeWord,
            activity,
            type,
            rawStatus,
            response,
            totalUsage: {
                prompt_tokens,
                completion_tokens,
                total_tokens
            }
        };
    }

    throw new Error(`Failed to generate a valid status after ${maxAttempts} attempts.`);
}

async function generateRolybotResponse(message) {
    const KEYWORD = "rolybot";
    const userPrompt = message.content;  // Get the content from the message object
    const userId = message.author.id;
    const channelId = message.channel.id;
    const lowerPrompt = userPrompt.toLowerCase();

    console.log(`[RolyBot] Message from ${userId} in ${channelId}: "${userPrompt}"`);
    const memoryKey = `${channelId}:${userId}`;

    if (!conversationMemory.has(memoryKey)) {
        conversationMemory.set(memoryKey, []);
    }
    
    const history = conversationMemory.get(memoryKey);
    history.push({
        role: 'user',
        content: userPrompt,
        username: message.author.username // Now 'message' is defined correctly
    });
    
    if (history.length > MAX_HISTORY) {
        history.splice(0, history.length - MAX_HISTORY);
    }
    
    console.log(history);

    // No keyword, exit early
    if (!lowerPrompt.includes(KEYWORD)) return null;

    const start = performance.now();
    try {
        const response = await openai.chat.completions.create({
            model: 'gpt-4o-mini-2024-07-18',
            //model: 'ft:gpt-4o-mini-2024-07-18:personal:rolybot:BNZFJA7N',
            messages: [
                { role: 'system', content: 'You are RolyBot, a helpful assistant in a Discord server. Remember what each user says and distinguish between different users by name.' },
                ...history
            ],
            temperature: 0.7,
            max_tokens: 150
        });

        const duration = performance.now() - start;
        console.log(`[RolyBot] Replied to ${userId} (${duration.toFixed(2)} ms)`);

        const reply = response.choices?.[0]?.message?.content?.trim() || "I'm not sure what to say!";
        history.push({ role: 'assistant', content: reply });

        if (history.length > MAX_HISTORY) {
            history.splice(0, history.length - MAX_HISTORY);
        }

        return reply;
    } catch (error) {
        console.error('[RolyBot] Error generating response:', error);
        return "Sorry, I had trouble thinking of a response :(";
    }
}

// Function to load conversation history
async function loadConversationHistory(channelId) {
    try {
        const channel = await client.channels.fetch(channelId);

        if (channel instanceof TextChannel) {
            const messages = await channel.messages.fetch({ limit: MAX_HISTORY });

            // Sort messages chronologically (oldest first)
            const sortedMessages = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);

            for (const message of sortedMessages) {
                const memoryKey = `${channelId}:${message.author.id}`;

                if (!conversationMemory.has(memoryKey)) {
                    conversationMemory.set(memoryKey, []);
                }

                const history = conversationMemory.get(memoryKey);
                history.push({
                    role: message.author.id === client.user.id ? 'assistant' : 'user',
                    content: message.content,
                    username: message.author.username
                });

                // Keep history within limit
                if (history.length > MAX_HISTORY) {
                    history.splice(0, history.length - MAX_HISTORY);
                }
            }

            console.log(`Preloaded ${sortedMessages.length} messages from channel ${channel.name}`);

        } else {
            console.log(`Skipping non-text channel ${channel.id} (${channel.name}).`);
        }
    } catch (error) {
        console.error(`Error in loadConversationHistory for channel ${channelId}:`, error);
    }
}