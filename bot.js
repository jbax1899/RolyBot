require('dotenv').config();
const { Client, GatewayIntentBits, Events, EmbedBuilder } = require('discord.js');
const logger = require('./utils/logger');
const { generateRolybotResponse, loadPosts } = require('./utils/rolybotResponse');
const { generateChessContext } = require('./utils/contextGenerators');
const { registerSlashCommands } = require('./utils/commandLoader');
const { recordRolybotRequest, tooManyRolybotRequests, goAFK } = require('./utils/openaiHelper');
const { classifyMessage } = require('./utils/messageClassifier.js');
const { getInstance: getGameManager } = require('./utils/chess/gameManager');
const MemoryManager = require('./utils/memoryManager');
const { ensureMemoryInitialized, getMemoryRetriever } = require('./utils/memoryUtils');
const memoryManager = MemoryManager.getInstance();

let gameManager;
const token = process.env.DISCORD_BOT_TOKEN;
const AFK_TIMEOUT = 10;
const THREAD_WHITELIST = ['No Context', 'Discussion']; // Thread names where RolyBot should not send messages (but can still react)

// Memory configuration - will be updated after MemoryManager is initialized
const MEMORY_CONFIG = {
    MAX_MEMORY_SIZE: 500,
    MEMORY_RATE_LIMIT: 1,
    SYNC_INTERVAL_MS: 1 * 60 * 1000,
    PRIORITY_CHANNEL_ID: '1362185428584890469'
};

global.MEMORY_CONFIG = MEMORY_CONFIG;

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

// Client ready event - initialize memories and set up message handling
client.once(Events.ClientReady, async () => {
    try {
        console.log(`Logged in as ${client.user.tag}!`);
        
        // Initialize memory manager and load initial memories
        await ensureMemoryInitialized(client);
        
        // Verify memory retriever is working
        const memoryRetriever = getMemoryRetriever();
        if (memoryRetriever) {
            console.log('Memory retriever initialized successfully');
        } else {
            console.warn('Memory retriever initialization completed but instance is not available');
        }
        
        // Register slash commands with Discord globally
        await registerSlashCommands(client.user.id, token);
        logger.info('Slash commands registered globally');

        // Initialize game manager
        try {
            gameManager = getGameManager(client);
            global.gameManager = gameManager;
            await gameManager.initialize();
            logger.info('Game manager initialized successfully');
        } catch (gameError) {
            logger.error('Failed to initialize game manager:', gameError);
            // Continue without game functionality
            global.gameManager = null;
        }

        // Set presence
        client.user.setPresence({ status: 'online' });
        logger.info(`Bot is online as ${client.user.tag}`);
        
    } catch (error) {
        console.error('Failed to initialize bot:', error);
        // Don't crash the bot if memory initialization fails
        // The bot can still function with limited capabilities
    }
});

// Handle slash command interactions
client.on(Events.InteractionCreate, async interaction => {
    logger.info(`[SlashCmd] Received interaction: ${interaction.commandName}`);
    if (!interaction.isCommand()) return;
    const command = slashCommands.get(interaction.commandName);
    if (!command) return;
    logger.info(`[SlashCmd] Executing command: ${interaction.commandName}`);
    try {
        await command.execute(interaction);
        logger.info(`[SlashCmd] Command executed successfully: ${interaction.commandName}`);
    } catch (error) {
        logger.error(`[SlashCmd] Error executing /${interaction.commandName}:`, error);
        await interaction.reply({ content: 'There was an error executing that command!', flags: 64 });
    }
});

// Handle incoming messages
client.on(Events.MessageCreate, async message => {
    if (message.content.startsWith('/')) return; // Ignore slash commands (handled by interactionCreate)
    if (message.author.id === client.user.id) return; // Ignore self

    // Only respond if the bot is mentioned or the message is a reply to the bot
    const isMentioned = message.mentions.has(client.user);
    let isReplyToBot = false;
    
    if (message.reference?.messageId) {
        try {
            const original = await message.channel.messages.fetch(message.reference.messageId);
            isReplyToBot = original.author.id === client.user.id;
        } catch (error) {
            logger.error('Error fetching referenced message:', error);
        }
    }

    if (!isMentioned && !isReplyToBot) return; // Skip if not mentioned and not a reply to the bot

    const isWhitelistedThread = message.channel.isThread() && 
                              THREAD_WHITELIST.includes(message.channel.name.toLowerCase());

    // Handle RolyBot responses
    // 1. If AFK, break
    // Note: Disabling this as RolyBot is sunset, as it is not needed as much
    /*
    if (rolybotAFK) {
        logger.info("[RolyBot] AFK/rate limited - ignoring trigger.");
        return;
    }
    */

    // 2. Run the classifiers
    let repliedTo = null;
    if (message.reference?.messageId) {
        try {
            const original = await message.channel.messages.fetch(message.reference.messageId);
            if (original.author.id === client.user.id) {
                isReplyToBot = true;
                repliedTo = original;
            }
        } catch (err) {
            logger.warn("[RolyBot] Could not fetch referenced message:", err);
        }
    }
    // Get recent messages for context
    let messageHistory = [];
    try {
        // Load recent messages (excluding current one)
        const recentMessages = await loadPosts(message.channel, 3);
        
        // Convert to the format expected by classifyMessage
        messageHistory = recentMessages.map(msg => ({
            author: msg.username,
            content: msg.content,
            isBot: msg.isBot || false
        }));
    } catch (err) {
        logger.warn("[RolyBot] Could not fetch message history:", err);
    }

    // Get legal moves if this is a chess move
    let legalMoves = [];
    try {
        const gameData = gameManager.getGameData(message.author.id);
        if (gameData && gameData.gameInstance) {
            legalMoves = gameData.gameInstance.moves({ verbose: true }).map(move => ({
                uci: move.from + move.to + (move.promotion || ''),
                san: move.san,
                piece: move.piece,
                from: move.from,
                to: move.to,
                captured: move.captured,
                promotion: move.promotion
            }));
        }
    } catch (err) {
        logger.warn("Could not get legal moves:", err);
    }

    // Prepare classification input
    const classificationInput = {
        content: message.content,
        author: message.author.username,
        isBot: message.author.bot,
        isReply: !!message.reference,
        messageHistory,
        legalMoves
    };
    
    // Log detailed input
    const inputDetails = `Content: ${message.content}\n` +
        `Author: ${message.author.username} (Bot: ${message.author.bot})\n` +
        `Is Reply: ${!!message.reference}\n` +
        `Message History (${messageHistory.length}):\n` +
        messageHistory.map((m, i) => 
            `  ${i + 1}. ${m.isBot ? 'BOT' : 'USER'} ${m.author}: ${m.content.substring(0, 50)}${m.content.length > 50 ? '...' : ''}`
        ).join('\n');
    
    logger.info(`Classification Input:\n${inputDetails}`);
    
    // Get classification
    const classification = await classifyMessage(classificationInput);
    
    // Log detailed output
    const outputDetails = `Input Length: ${message.content.length}\n` +
        `Input Preview: ${message.content.substring(0, 100)}${message.content.length > 100 ? '...' : ''}\n` +
        `Output: ${JSON.stringify(classification, null, 2)}\n` +
        `Has Respond: ${'respond' in classification}\n` +
        `Has Message: ${'message' in classification}\n` +
        `Has Emotes: ${!!(classification.emotes && classification.emotes.length > 0)}\n` +
        `Has Chess Commands: ${!!(classification.chess_commands && classification.chess_commands.length > 0)}`;
    logger.info(`Classification Output:\n${outputDetails}`);

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

    // 4. Handle chess commands if present
    if (classification.chess_commands) {
        const chessCommands = classification.chess_commands;
        
        // Process each chess command in order
        for (const cmd of chessCommands) {
            try {
                if (cmd.command === 'move') {
                    // Make the move
                    try {
                        await message.channel.send('Calculating move...');
                        const moveResult = await gameManager.makeMove(message.author.id, cmd.move, message);
                        
                        // Get the game state after the player's move (before AI move)
                        const playerMoveFen = moveResult.moveAfterPlayerMove || moveResult.gameData.fen;
                        const playerMoveImageUrl = await gameManager.getBoardImageUrl(playerMoveFen);
                        
                        // Show the board after player's move
                        const moveEmbed = new EmbedBuilder()
                            .setTitle('Chess Board')
                            .setColor(0x5865F2) // Discord blue
                            .setImage(playerMoveImageUrl)
                            .setDescription(`Your move: ${moveResult.move.san}`);
                        
                        // Send the player's move embed
                        await message.channel.send({ embeds: [moveEmbed] });
                        
                        // If AI made a move, show its move
                        if (moveResult.aiMove) {
                            const aiMoveEmbed = new EmbedBuilder()
                                .setTitle('Chess Board')
                                .setColor(0x5865F2)
                                .setImage(moveResult.aiMove.boardImageUrl)
                                .setDescription(`AI moved: ${moveResult.aiMove.move.san}`);
                            
                            await message.channel.send({ embeds: [aiMoveEmbed] });
                        }
                    } catch (err) {
                        logger.error(`[Chess] Error making move: ${err.message}`);
                        await message.channel.send('Invalid move. Please try again.');
                    }
                } else if (cmd.command === 'resign') {
                    // Handle resignation
                    try {
                        const game = gameManager.getGame(message.author.id);
                        if (!game) {
                            await message.channel.send('You do not have an active game to resign from.');
                            return;
                        }
                        
                        // Get opponent's ID
                        const opponentGame = gameManager.getOpponentGame(message.author.id);
                        const opponentId = opponentGame?.opponent;
                        
                        // End the game
                        gameManager.removeGame(message.author.id);
                        if (opponentId) {
                            gameManager.removeGame(opponentId);
                        }
                        
                        // Send resignation message
                        const resignMessage = opponentId 
                            ? `<@${message.author.id}> has resigned the game against <@${opponentId}>.`
                            : `<@${message.author.id}> has resigned the game.`;
                            
                        await message.channel.send(resignMessage);
                        
                        // Clean up thread if it exists
                        try {
                            const threadId = game.threadId || (opponentGame?.threadId);
                            if (threadId) {
                                const thread = await message.guild.channels.fetch(threadId);
                                if (thread) {
                                    await thread.send(resignMessage);
                                    // Optionally archive the thread
                                    await thread.setArchived(true).catch(e => logger.error('Error archiving thread:', e));
                                }
                            }
                        } catch (threadError) {
                            logger.error('Error cleaning up thread after resignation:', threadError);
                        }
                    } catch (error) {
                        logger.error('[Chess] Error processing resignation:', error);
                        await message.channel.send('An error occurred while processing your resignation.');
                    }
                }
            } catch (err) {
                logger.error(`[Chess] Error handling command ${cmd.command}: ${err.message}`);
                await message.channel.send('Error processing chess command. Please try again.');
            }
        }
        return;
    }

    if (rolybotBusy) {
        logger.info("[RolyBot] currently busy - ignoring trigger.");
        return;
    }

    // Check if we should respond
    if (!classification.respond // Classification indicates no response needed
            && !isReplyToBot) { // Not a reply to the bot
        //logger.info("[RolyBot] Classification indicates no response needed");
        return;
    }
    
    // Skip RolyBot responses in whitelisted threads
    if (isWhitelistedThread) {
        logger.info("[RolyBot] In whitelisted thread - skipping response");
        return;
    }

    recordRolybotRequest();
    
    if (tooManyRolybotRequests()) {
        logger.info("[RolyBot] rate limited - ignoring trigger.");
        if (!rolybotAFK) {
            await goAFK(client, AFK_TIMEOUT, message, setAFK);
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

        // If reply to bot, add reply context
        let msgContent = message.content;
        if (isReplyToBot && repliedTo) {
            msgContent = `In reply to: ${repliedTo.content}\n${msgContent}`;
        }

        // If in a chess thread, add context
        let chessRoom = '';
        let chessContext = '';
        
        // Check if this is a chess thread and get game context
        if (message.channel && message.channel.type === 11 && message.channel.name && message.channel.name.toLowerCase().includes('chess vs')) {
            chessRoom = `[in thread: ${message.channel.name.toLowerCase()}]\n`;
            
            // Get all games that have this thread ID
            const games = gameManager.gameStateManager.games;
            const gameEntry = Object.entries(games).find(([_, game]) => 
                game.threadId === message.channel.id
            );
            
            if (gameEntry) {
                const [playerId, gameData] = gameEntry;
                // Get the chess context for both players in this thread
                const context = generateChessContext(playerId);
                if (context) {
                    chessContext = `\n\n--- Current Chess Game ---\n${context}\n\n`;
                }
            }
        }

        logger.info(`Sending message to RolyBot: ${chessRoom + chessContext + msgContent}`);
        
        const response = await generateRolybotResponse(client, message, (chessRoom + chessContext + msgContent));
        if (response) await message.reply(response);
    } catch (err) {
        logger.error("[RolyBot] generateRolybotResponse error:", err);
    } finally {
        clearInterval(typingInterval);
        rolybotBusy = false;
    }
});