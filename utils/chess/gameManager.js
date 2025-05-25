const logger = require('../logger');
const { getBoardImageUrl } = require('./game');
const challengeManager = require('./challengeManager');
const gameStateManager = require('./gameStateManager');
const aiMoveService = require('./aiMoveService');
const threadManager = require('./threadManager');
const { getInstance: getThreadUtils } = require('./threadUtils');

class GameManager {
    constructor() {
        this.challengeManager = challengeManager;
        this.gameStateManager = gameStateManager;
        this.aiMoveService = aiMoveService;
        
        // Initialize thread utils with our game state manager
        const threadUtils = getThreadUtils(gameStateManager);
        // Pass the thread utils instance to threadManager
        threadManager.setThreadUtils(threadUtils);
    }

    /**
     * Create a new two-player game and assign colors
     * @param {string} playerAId - First player ID
     * @param {string} playerBId - Second player ID
     * @param {string} difficulty - Game difficulty
     * @returns {{white: string, black: string, fen: string}} Game info
     */
    createGameForPlayers(playerAId, playerBId, difficulty = 'medium') {
        if (this.gameStateManager.hasExistingGame(playerAId, playerBId)) {
            throw new Error('A game already exists between these players');
        }
        return this.gameStateManager.createGame(playerAId, playerBId, difficulty);
    }

    /**
     * Check if a game already exists between two players
     * @param {string} player1 - First player ID
     * @param {string} player2 - Second player ID
     * @returns {boolean} True if a game exists, false otherwise
     */
    hasExistingGame(player1, player2) {
        return this.gameStateManager.hasExistingGame(player1, player2);
    }

    /**
     * Handle a chess challenge or game request
     * @param {string} challengerId
     * @param {string} challengedUserId
     * @param {Interaction} interaction
     * @param {boolean} useVoiceChat
     */
    async handleChallenge(challengerId, challengedUserId, interaction, useVoiceChat = false) {
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
                        if (thread && thread.messages.cache.size > 0) {
                            const lastMessageId = thread.messages.cache.last().id;
                            const threadLink = `https://discord.com/channels/${interaction.guild.id}/${threadId}/${lastMessageId}`;
                            await interaction.followUp({
                                content: `A game already exists between you and <@${opponentId}>. Join the game here: ${threadLink}`,
                                flags: 64
                            });
                            return true;
                        }
                    }
                } catch (err) {
                    logger.error(`[Chess] Error finding existing game thread: ${err.message}`);
                }
                
                // If we couldn't find the thread or there was an error, still provide a helpful message
                await interaction.followUp({
                    content: `A game already exists between you and <@${opponentId}>. Please complete that game before starting a new one.`,
                    flags: 64
                });
                return false;
            }

            // If we get here, no existing game was found - continue with game creation
            const gameData = await this.createGameForPlayers(challengerId, opponentId);
            const { white, black, fen } = gameData;
            const client = interaction.client;
            const guild = interaction.guild;

            const thread = await threadManager.createGameThread(client, guild, white, black);
            await threadManager.setThreadIdForUser(white, thread.id);
            await threadManager.setThreadIdForUser(black, thread.id);

            // Post welcome message
            const { EmbedBuilder } = require('discord.js');
            const welcomeEmbed = new EmbedBuilder()
                .setTitle('Chess Match Started!')
                .setDescription(`Welcome <@${white}> (White) vs <@${black}> (Black)\n\n**Participants:**\n- <@${white}> (White)\n- <@${black}> (Black)\n\nAnyone can spectate this thread!`)
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
            if (white === interaction.client.user.id) {
                await this.makeAIMove(gameData, white);
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

    /**
     * Add a pending challenge
     * @param {string} challengerId
     * @param {string} challengedUserId
     * @returns {boolean} True if challenge was added, false if a challenge already exists
     */
    addChallenge(challengerId, challengedUserId) {
        return this.challengeManager.addChallenge(challengerId, challengedUserId);
    }

    /**
     * Remove a pending challenge for a user
     * @param {string} challengedUserId
     * @returns {boolean} True if a challenge was removed, false otherwise
     */
    removeChallenge(challengedUserId) {
        return this.challengeManager.removeChallenge(challengedUserId);
    }

    /**
     * Get a pending challenge for a user
     * @param {string} challengedUserId
     * @returns {Object|null} Challenge object or null if not found
     */
    getChallenge(challengedUserId) {
        return this.challengeManager.getChallenge(challengedUserId);
    }

    /**
     * Get all pending challenges (for admin/debug)
     * @returns {Array<Object>} Array of all pending challenges
     */
    getAllChallenges() {
        return this.challengeManager.getAllChallenges();
    }

    /**
     * Get game instance for user
     * @param {string} userId - Discord user ID
     * @returns {Game|null} Game instance or null if not found
     */
    getGame(userId) {
        const gameData = this.gameStateManager.getGame(userId);
        if (!gameData) return null;
        const { Game } = require('./game');
        return new Game(gameData.playerColor, gameData.difficulty, gameData.fen);
    }

    /**
     * Get opponent's game data
     * @param {string} userId - Discord user ID
     * @returns {Object|null} Opponent's game data or null if not found
     */
    getOpponentGame(userId) {
        return this.gameStateManager.getOpponentGame(userId);
    }

    /**
     * Get game data for a user
     * @param {string} userId - Discord user ID
     * @returns {Object|null} Game data or null if not found
     */
    getGame(userId) {
        return this.gameStateManager.getGame(userId);
    }

    /**
     * Make a move in the game
     * @param {string} userId - Discord user ID making the move
     * @param {string} move - Move in SAN or coordinate notation
     * @returns {Promise<Object>} Move result
     * @throws {Error} If game not found or move is invalid
     */
    async makeMove(userId, move) {
        const game = this.getGame(userId);
        if (!game) {
            throw new Error('No active game found. Start one with !rb chess start.');
        }
        
        // Make the move
        const moveObj = game.makeMove(move);
        
        // Update both players' game states with the new FEN
        const newFen = game.board.fen();
        this.gameStateManager.updateGame(userId, { fen: newFen });
        
        // Get opponent's ID to update their game state
        const opponentGame = this.gameStateManager.getOpponentGame(userId);
        if (opponentGame) {
            this.gameStateManager.updateGame(opponentGame.opponent, { fen: newFen });
        }
        
        return moveObj;
    }

    /**
     * Make an AI move using Stockfish
     * @param {Game} game - Game instance
     * @param {string} userId - Discord user ID of the AI player
     * @returns {Promise<Object>} Move result
     * @throws {Error} If move fails or game is invalid
     */
    async makeAIMove(game, userId) {
        if (!game || !game.board) {
            throw new Error('Invalid game instance');
        }
        
        const moveObj = await this.aiMoveService.makeAIMove(game, userId);
        
        // Update game state with the new FEN after AI move
        const newFen = game.board.fen();
        this.gameStateManager.updateGame(userId, { fen: newFen });
        
        // Update opponent's game state
        const opponentGame = this.gameStateManager.getOpponentGame(userId);
        if (opponentGame) {
            this.gameStateManager.updateGame(opponentGame.opponent, { fen: newFen });
        }
        
        return moveObj;
    }

    /**
     * Get current turn for a game
     * @param {string} userId - Discord user ID
     * @returns {string} 'white' or 'black' indicating whose turn it is
     * @throws {Error} If game not found
     */
    getTurn(userId) {
        const game = this.getGame(userId);
        if (!game) {
            throw new Error('No active game found');
        }
        return game.getTurn();
    }

    /**
     * Remove a game
     * @param {string} userId - User ID
     * @returns {boolean} True if game was removed, false otherwise
     */
    removeGame(userId) {
        return this.gameStateManager.removeGame(userId);
    }
}

// Export singleton instance
const gameManager = new GameManager();
module.exports = gameManager;