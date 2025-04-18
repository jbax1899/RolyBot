require('dotenv').config(); // only needed for local development


// Discord
const { Client, GatewayIntentBits, EmbedBuilder, Events } = require('discord.js');
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
            try {
                const typeMap = {
                    'Playing': 0,
                    'Streaming': 1,
                    'Listening': 2,
                    'Watching': 3
                };

                const typeList = Object.keys(typeMap);
                const randomType = typeList[Math.floor(Math.random() * typeList.length)];

                const prompt = `You are a Discord bot that generates funny statuses, one short sentence with the format "<type> <activity>" (without the quotes), where type is ${randomType}.
                                For example: "Listening to my music playlist"
                                Do not include quotes, markdown, links, hashtags, mentions, or formatting.
                                Keep it clean-ish and funny.
                                Target audience: 20s-30s, tech-savvy, enjoys memes and pop culture references.
                                Ensure the total length is less than 128 characters.`;

                const response = await openai.completions.create({
                    model: 'gpt-3.5-turbo-instruct',
                    prompt: prompt,
                    temperature: 0.7,
                    max_tokens: 9
                });

                let rawStatus = response.choices[0].text.trim();

                // Remove any extra quotes (i.e., surrounding quotes)
                rawStatus = rawStatus.replace(/^"(.*)"$/, '$1').trim();

                // Parse the type and activity
                const [typeWord, ...activityParts] = rawStatus.split(' ');
                const activity = activityParts.join(' ').slice(0, 118);  // Ensure activity doesn't exceed 118 characters

                const type = typeMap[typeWord];

                if (type === undefined || !activity) {
                    throw new Error(`Invalid status format received: "${rawStatus}"`);
                }

                client.user.setPresence({
                    activities: [{
                        name: activity,
                        type: type // 0 = Playing, 1 = Streaming, 2 = Listening, 3 = Watching
                    }],
                    status: 'online'
                });

                // Log the status update
                console.log(`Status updated to: "${typeWord} ${activity}"`);
                message.channel.send(`✅ Status updated to: **${typeWord} ${activity}**`);

                // Log API useage and cost
                const usage = response.usage;
                if (usage) {
                    const inputTokens = usage.prompt_tokens || 0;
                    const outputTokens = usage.completion_tokens || 0;
                    const totalTokens = usage.total_tokens || 0;

                    // https://platform.openai.com/docs/pricing
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

// Bot ready event
client.on('ready', () => {
    client.user.setPresence({ status: 'online' });
    console.log('Bot loaded and ready.');
});

// Listens for commands
client.on(Events.MessageCreate, message => {
    // Ignore messages sent by the bot itself
    if (message.author.id === client.user.id) return;

    // Make sure the message starts with the command prefix
    if (!message.content.startsWith(COMMAND_PREFIX)) return;

    // Check if the message is from a thread (needed for threads)
    if (message.channel.isThread()) {}

    // Parse command and arguments
    const args = message.content.slice(COMMAND_PREFIX.length).trim().split(/ +/);
    const commandName = args.shift().toLowerCase();

    const command = commands[commandName];
    if (!command) {
        message.channel.send(`Unknown command: \`${commandName}\``);
        return;
    }

    // Log who ran the command
    console.log(`EXECUTE COMMAND: "${commandName}" from user "${message.author.username}" (ID: ${message.author.id})`);

    // Execute the command
    command.execute(message, args);
});