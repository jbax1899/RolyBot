/**
 * Game Manager - Core orchestrator for chess game logic and flow control
 * Handles game lifecycle, move validation, AI moves, and Discord interactions
 * 
 * Main Functions:
 * - createGameInstance: Creates a new chess game instance with optional FEN and difficulty
 * - getTurn: Gets the current turn color for a game
 * - createGameForPlayers: Creates a new game between two players
 * - hasExistingGame: Checks if a game exists between two players
 * - handleChallenge: Processes chess challenges between players
 * - add/remove/getChallenge: Manages challenge state
 * - makeMove: Processes a move in the game
 * - makeAIMove: Executes AI move logic
 * - getGame/getOpponentGame: Retrieves game state
 */

const { Chess } = require('chess.js');
const gameStateManager = require('./gameStateManager');
const logger = require('../logger');
const challengeManager = require('./challengeManager');
const { instance: aiMoveService } = require('./aiMoveService');
const threadManager = require('./threadManager');
const threadUtils = require('./threadUtils');

/**
 * Generate a board image URL from FEN
 */
async function getBoardImageUrl(fen) {
    if (!fen || typeof fen !== 'string') throw new Error('Invalid FEN string');
    return `https://fen2png.com/api/?fen=${encodeURIComponent(fen)}&raw=true`;
}

let instance = null;

class GameManager {
    constructor(client) {
        this.client = client;
        this.challengeManager = challengeManager;
        this.aiMoveService = aiMoveService;
        this.gameStateManager = gameStateManager;
        this.initialized = false;
        
        // Initialize thread utils with both game state manager and client
        const threadUtilsInstance = threadUtils.getInstance(gameStateManager, client);
        threadManager.setThreadUtils(threadUtilsInstance);
        threadManager.setClient(client);
    }
    
    async initialize() {
        if (this.initialized) return;
        
        try {
            await this.gameStateManager.initialize();
            this.initialized = true;
        } catch (error) {
            logger.error('Failed to initialize GameManager:', error);
            throw error;
        }
    }

    createGameInstance(playerColor = 'w', difficulty = 'intermediate', fen = null) {
        const game = fen ? new Chess(fen) : new Chess();
        game.difficulty = difficulty;
        game.playerColor = playerColor;
        return game;
    }

    makeMove(game, move) {
        if (!game || !(game instanceof Chess)) {
            throw new Error('Invalid game instance');
        }
        
        if (!move || typeof move !== 'string') {
            throw new Error('Invalid move');
        }
        
        const currentTurn = game.turn();
        if ((currentTurn === 'w' && game.playerColor !== 'w') || 
            (currentTurn === 'b' && game.playerColor !== 'b')) {
            throw new Error(`It's not your turn. It's ${currentTurn === 'w' ? 'White' : 'Black'}'s turn.`);
        }
        
        let result = game.move(move);
        if (!result) {
            const coordMove = move.replace(/([a-h])([1-8])([a-h])([1-8])/i, '$1$2-$3$4');
            result = game.move(coordMove);
        }

        if (!result) {
            throw new Error(`Invalid move: ${move}`);
        }

        return result;
    }

    getTurn(game) {
        if (!game || !(game instanceof Chess)) {
            throw new Error('Invalid game instance');
        }
        return game.turn() === 'w' ? 'white' : 'black';
    }

    async createGameForPlayers(player1Id, player2Id, difficulty = 'intermediate') {
        try {
            // Check if game already exists between these players
            if (this.hasExistingGame(player1Id, player2Id)) {
                return { success: false, message: 'A game already exists between these players.' };
            }

            // Randomly assign colors
            const isPlayer1White = Math.random() >= 0.5;
            const whiteId = isPlayer1White ? player1Id : player2Id;
            const blackId = isPlayer1White ? player2Id : player1Id;

            // Create the game instance
            const game = this.createGameInstance('w', difficulty);
            const fen = game.fen();
            
            // Create game data in state manager
            const gameData = this.gameStateManager.createGame(whiteId, blackId, difficulty, fen);
            
            // Store the game instance in the game data
            const whiteGameData = this.gameStateManager.getGame(whiteId);
            const blackGameData = this.gameStateManager.getGame(blackId);
            
            if (whiteGameData) whiteGameData.gameInstance = game;
            if (blackGameData) blackGameData.gameInstance = game;
            
            return { 
                success: true, 
                game: { ...gameData, gameInstance: game },
                whitePlayerId: whiteId,
                blackPlayerId: blackId
            };
        } catch (error) {
            logger.error(`[GameManager] Error in createGameForPlayers: ${error.message}`);
            return { success: false, message: 'Failed to create game.' };
        }
    }

    hasExistingGame(player1, player2) {
        return this.gameStateManager.hasExistingGame(player1, player2);
    }

    async handleChallenge(challengerId, challengedUserId, interaction, useVoiceChat = false, difficulty = 'intermediate') {
        const opponentId = challengedUserId || interaction.client.user.id;
        
        try {
            // Defer the reply with flags instead of ephemeral
            await interaction.deferReply({ flags: 64 }); // 64 is the flag for ephemeral

            if (this.hasExistingGame(challengerId, opponentId)) {
                try {
                    const threadId = threadManager.getThreadIdForUser(challengerId) || 
                                    threadManager.getThreadIdForUser(opponentId);
                    
                    if (threadId) {
                        const thread = await interaction.guild.channels.fetch(threadId);
                        if (thread) {
                            let threadLink = `https://discord.com/channels/${interaction.guild.id}/${threadId}`;
                            // Try to get the last message ID if it exists
                            try {
                                const messages = await thread.messages.fetch({ limit: 1 });
                                if (messages.size > 0) {
                                    threadLink += `/${messages.first().id}`;
                                }
                            } catch (err) {
                                logger.debug(`[Chess] Couldn't fetch last message for thread ${threadId}:`, err.message);
                            }
                            
                            await interaction.followUp({
                                content: `A game already exists between you and <@${opponentId}>. Continue your game here: ${threadLink}`,
                                flags: 64
                            });
                            return true;
                        }
                    }
                } catch (err) {
                    logger.error(`[Chess] Error finding existing game thread:`, err);
                    // Fall through to the default message
                }
                
                // If we couldn't find the thread or there was an error, still provide a helpful message
                await interaction.followUp({
                    content: `A game already exists between you and <@${opponentId}>. Please complete that game before starting a new one.`,
                    flags: 64
                });
                return false;
            }

            // If we get here, no existing game was found - continue with game creation
            logger.info(`[GameManager] Creating new game between ${challengerId} and ${opponentId} with difficulty: ${difficulty}`);
            const result = await this.createGameForPlayers(challengerId, opponentId, difficulty);
            
            if (!result.success) {
                await interaction.followUp({
                    content: result.message || 'Failed to create game.',
                    flags: 64
                });
                return false;
            }
            
            const { game: gameData, whitePlayerId, blackPlayerId } = result;
            const { fen, gameInstance } = gameData;
            
            if (!gameInstance) {
                throw new Error('Failed to create game instance');
            }
            
            // Inform players about their colors
            const challengerColor = whitePlayerId === challengerId ? 'white' : 'black';
            const opponentColor = whitePlayerId === opponentId ? 'white' : 'black';
            
            await interaction.followUp({
                content: `Game started! <@${challengerId}> is playing as **${challengerColor}** and <@${opponentId}> is playing as **${opponentColor}**`,
                flags: 64
            });
            
            logger.info(`[GameManager] Game created. White: ${whitePlayerId}, Black: ${blackPlayerId}, FEN: ${fen}`);
            
            // Update game state with the game instance
            this.gameStateManager.updateGame(whitePlayerId, { gameInstance });
            this.gameStateManager.updateGame(blackPlayerId, { gameInstance });
            
            const client = interaction.client;
            const guild = interaction.guild;
            const channel = interaction.channel;

            try {
                // Create game thread in the current channel
                const thread = await threadManager.createGameThread(client, guild, whitePlayerId, blackPlayerId, channel);
                logger.info(`[GameManager] Created game thread: ${thread.id}`);
                
                // Update game state with thread ID
                this.gameStateManager.updateGame(whitePlayerId, { threadId: thread.id });
                this.gameStateManager.updateGame(blackPlayerId, { threadId: thread.id });
                
                await threadManager.setThreadIdForUser(whitePlayerId, thread.id);
                await threadManager.setThreadIdForUser(blackPlayerId, thread.id);

                // Post welcome message
                const { EmbedBuilder } = require('discord.js');
                const welcomeEmbed = new EmbedBuilder()
                    .setTitle('Chess Match Started!')
                    .setDescription(`Welcome <@${whitePlayerId}> (White) vs <@${blackPlayerId}> (Black)\n\n**Participants:**\n- <@${whitePlayerId}> (White)\n- <@${blackPlayerId}> (Black)\n\nAnyone can spectate this thread!`)
                    .setColor(0x5865F2);
                await thread.send({ embeds: [welcomeEmbed] });

                // Post initial board image
                const boardImageUrl = await getBoardImageUrl(fen);
                const boardEmbed = new EmbedBuilder()
                    .setTitle('Chess Board')
                    .setImage(boardImageUrl)
                    .setDescription('Initial position');
                await thread.send({ embeds: [boardEmbed] });

                // If white is the bot, make the first move
                if (whitePlayerId === interaction.client.user.id) {
                    logger.info(`[GameManager] Bot is white, making first move`);
                    const moveResult = await this.makeAIMove(gameData, white);
                    
                    // Update board after AI move
                    if (moveResult && moveResult.fen) {
                        const updatedBoardEmbed = new EmbedBuilder()
                            .setTitle('Chess Board')
                            .setImage(await getBoardImageUrl(moveResult.fen))
                            .setDescription(`Bot played ${moveResult.san}`);
                        await thread.send({ embeds: [updatedBoardEmbed] });
                    }
                }
            } catch (threadError) {
                logger.error(`[GameManager] Error in game thread setup: ${threadError.message}`, threadError);
                throw new Error('Failed to set up game thread');
            }

            return true;
            
        } catch (error) {
            logger.error(`[GameManager] Error in handleChallenge: ${error.message}`);
            try {
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({ content: 'An error occurred while processing your request.', ephemeral: true });
                } else {
                    await interaction.followUp({ content: 'An error occurred while processing your request.', flags: 64 });
                }
            } catch (e) {
            }
            return false;
        }
    }

    addChallenge(challengerId, challengedUserId) {
        return this.challengeManager.addChallenge(challengerId, challengedUserId);
    }

    removeChallenge(challengedUserId) {
        return this.challengeManager.removeChallenge(challengedUserId);
    }

    getChallenge(challengedUserId) {
        return this.challengeManager.getChallenge(challengedUserId);
    }

    getAllChallenges() {
        return this.challengeManager.getAllChallenges();
    }

    getGame(userId) {
        const gameData = this.gameStateManager.getGame(userId);
        if (!gameData?.gameInstance) {
            logger.error(`No game instance found for user ${userId}`);
            return null;
        }
        return gameData.gameInstance;
    }

    getOpponentGame(userId) {
        return this.gameStateManager.getOpponentGame(userId);
    }

    getGameData(userId) {
        return this.gameStateManager.getGame(userId);
    }

    async makeMove(userId, move, message) {
        const gameData = this.gameStateManager.getGame(userId);
        if (!gameData || !gameData.gameInstance) {
            throw new Error('No active game found. Start one with !rb chess start.');
        }
        
        const game = gameData.gameInstance;
        
        try {
            // Check if it's the player's turn
            const currentTurn = game.turn();
            const playerColor = gameData.playerColor || 'w'; // Default to white if not set
            
            if ((currentTurn === 'w' && playerColor !== 'w') || 
                (currentTurn === 'b' && playerColor !== 'b')) {
                throw new Error(`It's not your turn. It's ${currentTurn === 'w' ? 'White' : 'Black'}'s turn.`);
            }
            
            // Make the move
            logger.info(`[GameManager] Attempting move ${move} for user ${userId} (${playerColor})`);
            const moveObj = game.move(move);
            
            if (!moveObj) {
                // Try alternative move format if standard move fails
                const coordMove = move.replace(/([a-h])([1-8])([a-h])([1-8])/i, '$1$2-$3$4');
                const altMoveObj = game.move(coordMove);
                
                if (!altMoveObj) {
                    throw new Error(`Invalid move: ${move}`);
                }
                return altMoveObj;
            }
            
            // Update the game state with the new FEN
            const newFen = game.fen();
            logger.info(`[GameManager] Move successful, new FEN: ${newFen}`);
            
            // Update both players' game states with the new FEN and game instance
            this.gameStateManager.updateGame(userId, { fen: newFen, gameInstance: game });
            
            // Get opponent data
            const opponentId = gameData.opponent;
            const opponentData = this.gameStateManager.getGame(opponentId);
            
            // Save the FEN after player's move (before AI move)
            const fenAfterPlayerMove = game.fen();
            
            if (opponentData) {
                opponentData.gameInstance = game; // Update the game instance reference
                this.gameStateManager.updateGame(opponentId, { fen: newFen, gameInstance: game });
            }
            
            const isAITurn = this.client && opponentId === this.client.user?.id;
            
            if (isAITurn && message) {
                try {
                    await message.channel.send("AI is thinking...");
                    const aiMoveResult = await this.makeAIMove(opponentData, opponentId);
                    
                    if (aiMoveResult) {
                        const updatedGameData = this.gameStateManager.getGame(userId);
                        const aiBoardImageUrl = await this.getBoardImageUrl(aiMoveResult.fen);
                        
                        return {
                            move: {
                                san: moveObj.san,
                                from: moveObj.from,
                                to: moveObj.to,
                                promotion: moveObj.promotion,
                                color: moveObj.color,
                                flags: moveObj.flags,
                                piece: moveObj.piece,
                                captured: moveObj.captured
                            },
                            moveAfterPlayerMove: fenAfterPlayerMove, // FEN after player's move
                            isAITurn: false,
                            gameData: updatedGameData,
                            aiMove: {
                                move: aiMoveResult.move,
                                boardImageUrl: aiBoardImageUrl
                            }
                        };
                    }
                } catch (aiError) {
                    logger.error('Error making AI move:', aiError);
                    throw new Error(`AI move failed: ${aiError.message}`);
                }
            }
            
            return { 
                move: {
                    san: moveObj.san,
                    from: moveObj.from,
                    to: moveObj.to,
                    promotion: moveObj.promotion,
                    color: moveObj.color,
                    flags: moveObj.flags,
                    piece: moveObj.piece,
                    captured: moveObj.captured
                }, 
                isAITurn: false, 
                gameData: opponentData 
            };
        } catch (error) {
            logger.error('Error making move:', error);
            throw new Error(`Failed to make move: ${error.message}`);
        }
    }

    async makeAIMove(gameData, userId, difficulty) {
        if (!gameData?.gameInstance) {
            throw new Error('Invalid game instance');
        }
        
        const game = gameData.gameInstance;
        difficulty = difficulty || gameData.difficulty || 'intermediate';
        
        try {
            // Get the AI move without making it on the board yet
            const moveResult = await this.aiMoveService._getBestMove(game.fen(), difficulty);
            
            if (!moveResult) {
                throw new Error('AI failed to generate a valid move');
            }
            
            // Make the move on the game instance
            const move = game.move({
                from: moveResult.from,
                to: moveResult.to,
                promotion: moveResult.promotion || 'q' // Default to queen promotion
            });
            
            if (!move) {
                throw new Error('Invalid AI move');
            }
            
            const newFen = game.fen();
            
            // Update the game instance for both players
            const opponentId = gameData.opponent;
            this.gameStateManager.updateGame(userId, { 
                fen: newFen, 
                gameInstance: game,
                lastMove: move.san,
                lastMoveAt: new Date().toISOString()
            });
            
            if (opponentId) {
                this.gameStateManager.updateGame(opponentId, { 
                    fen: newFen,
                    gameInstance: game,
                    lastMove: move.san,
                    lastMoveAt: new Date().toISOString()
                });
            }
            
            return {
                move: {
                    san: move.san,
                    from: move.from,
                    to: move.to,
                    promotion: move.promotion,
                    color: move.color,
                    flags: move.flags,
                    piece: move.piece,
                    captured: move.captured
                },
                fen: newFen,
                boardImageUrl: await this.getBoardImageUrl(newFen),
                gameOver: game.isGameOver(),
                inCheck: game.inCheck(),
                inCheckmate: game.isCheckmate(),
                inDraw: game.isDraw(),
                inStalemate: game.isStalemate(),
                inThreefoldRepetition: game.isThreefoldRepetition(),
                insufficientMaterial: game.isInsufficientMaterial()
            };
        } catch (error) {
            logger.error('Error in makeAIMove:', error);
            throw new Error(`AI move failed: ${error.message}`);
        }
    }

    getTurn(userId) {
        const gameData = gameStateManager.getGame(userId);
        if (!gameData || !gameData.gameInstance) {
            throw new Error('No active game found');
        }
        return gameData.gameInstance.turn();
    }

    removeGame(userId) {
        return gameStateManager.removeGame(userId);
    }

    getBoardImageUrl(fen) {
        return getBoardImageUrl(fen);
    }
}

const getInstance = (client) => {
    if (!instance) {
        if (!client) {
            throw new Error('GameManager must be initialized with a client first');
        }
        instance = new GameManager(client);
    }
    return instance;
};

const getInstanceIfExists = () => instance;

module.exports = {
    getInstance,
    getInstanceIfExists,
    getGameManager: () => instance,
    getBoardImageUrl
};