const fs = require('fs');
const path = require('path');
const { Game } = require('./game');
const logger = require('../logger');

class GameStateManager {
    constructor(savePath) {
        this.games = new Map();
        this.savePath = savePath;
        this.saveDir = path.dirname(savePath);
        this.loadGames();
    }

    /**
     * Save all games to disk
     */
    saveGames() {
        const data = {};
        for (const [userId, gameData] of this.games.entries()) {
            data[userId] = {
                fen: gameData.fen,
                playerColor: gameData.playerColor,
                opponent: gameData.opponent,
                threadId: gameData.threadId,
                difficulty: gameData.difficulty
            };
        }

        try {
            if (!fs.existsSync(this.saveDir)) {
                fs.mkdirSync(this.saveDir, { recursive: true });
            }
            fs.writeFileSync(this.savePath, JSON.stringify(data, null, 2));
        } catch (error) {
            logger.error(`[GameStateManager] Error saving games: ${error.message}`);
            throw error;
        }
    }

    /**
     * Load games from disk
     */
    loadGames() {
        if (!fs.existsSync(this.savePath)) {
            logger.info('[GameStateManager] No saved games found');
            return;
        }

        try {
            const data = JSON.parse(fs.readFileSync(this.savePath, 'utf8'));
            for (const [userId, gameData] of Object.entries(data)) {
                this.games.set(userId, {
                    fen: gameData.fen,
                    playerColor: gameData.playerColor,
                    opponent: gameData.opponent,
                    threadId: gameData.threadId,
                    difficulty: gameData.difficulty || 'medium'
                });
            }
            logger.info(`[GameStateManager] Loaded ${this.games.size} games`);
        } catch (error) {
            logger.error(`[GameStateManager] Error loading games: ${error.message}`);
        }
    }

    /**
     * Get game data for a user
     * @param {string} userId - User ID
     * @returns {Object|null} Game data or null if not found
     */
    getGame(userId) {
        return this.games.get(userId) || null;
    }

    /**
     * Get opponent's game data
     * @param {string} userId - User ID
     * @returns {Object|null} Opponent's game data or null if not found
     */
    getOpponentGame(userId) {
        const gameData = this.games.get(userId);
        if (!gameData || !gameData.opponent) return null;
        return this.games.get(gameData.opponent);
    }

    /**
     * Create a new game between two players
     * @param {string} playerAId - First player ID
     * @param {string} playerBId - Second player ID
     * @param {string} difficulty - Game difficulty
     * @returns {{white: string, black: string, fen: string}} Game info
     */
    createGame(playerAId, playerBId, difficulty = 'medium') {
        const isAWhite = Math.random() < 0.5;
        const whiteId = isAWhite ? playerAId : playerBId;
        const blackId = whiteId === playerAId ? playerBId : playerAId;

        const game = new Game('w', difficulty);
        const gameData = {
            fen: game.board.fen(),
            opponent: blackId,
            playerColor: 'w',
            threadId: null,
            difficulty
        };

        this.games.set(whiteId, { ...gameData, playerColor: 'w' });
        this.games.set(blackId, { ...gameData, playerColor: 'b', opponent: whiteId });
        this.saveGames();

        return { white: whiteId, black: blackId, fen: gameData.fen };
    }

    /**
     * Update game state for a player
     * @param {string} userId - User ID
     * @param {Object} updates - Game state updates
     */
    updateGame(userId, updates) {
        const gameData = this.games.get(userId);
        if (gameData) {
            this.games.set(userId, { ...gameData, ...updates });
            this.saveGames();
        }
    }

    /**
     * Remove a game
     * @param {string} userId - User ID
     * @returns {boolean} True if game was removed, false otherwise
     */
    removeGame(userId) {
        const gameData = this.games.get(userId);
        if (gameData) {
            const opponentId = gameData.opponent;
            this.games.delete(userId);
            if (opponentId) {
                this.games.delete(opponentId);
            }
            this.saveGames();
            return true;
        }
        return false;
    }

    /**
     * Check if a game exists between two players
     * @param {string} player1 - First player ID
     * @param {string} player2 - Second player ID
     * @returns {boolean} True if a game exists, false otherwise
     */
    hasExistingGame(player1, player2) {
        const player1Game = this.games.get(player1);
        const player2Game = this.games.get(player2);
        return (player1Game?.opponent === player2) || (player2Game?.opponent === player1);
    }
}

// Export singleton instance
const gameStateManager = new GameStateManager(path.join(__dirname, 'games.json'));
module.exports = gameStateManager;
