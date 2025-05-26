/**
 * Manages chess game state persistence and instance management.
 * Handles game creation, updates, and synchronization between players.
 * Persists game state to disk and restores it on restart.
 * 
 * @typedef {Object} GameState
 * @property {string} fen - Current FEN string
 * @property {'w'|'b'} playerColor - Player's color
 * @property {string} opponent - Opponent's user ID
 * @property {?string} threadId - Discord thread ID
 * @property {string} difficulty - AI difficulty level
 * @property {Chess} gameInstance - chess.js game instance
 */

const fs = require('fs');
const path = require('path');
const Chess = require('chess.js').Chess;
const logger = require('../logger');

class GameStateManager {
    constructor(savePath) {
        this.games = new Map();
        this.savePath = savePath;
        this.saveDir = path.dirname(savePath);
        this.initialized = false;
    }
    
    async initialize() {
        if (this.initialized) {
            logger.info('[GameStateManager] Already initialized');
            return;
        }
        
        logger.info('[GameStateManager] Initializing...');
        
        try {
            // Ensure the save directory exists
            if (!fs.existsSync(this.saveDir)) {
                fs.mkdirSync(this.saveDir, { recursive: true });
                logger.info(`[GameStateManager] Created save directory: ${this.saveDir}`);
            }
            
            // Load existing games
            this.loadGames();
            
            this.initialized = true;
            logger.info('[GameStateManager] Initialization complete');
        } catch (error) {
            logger.error('[GameStateManager] Error during initialization:', error);
            throw error;
        }
    }

    loadGames() {
        try {
            if (!fs.existsSync(this.savePath)) {
                logger.info('[GameStateManager] No saved games found, starting fresh');
                this.games = new Map();
                this.saveGames();
                return true;
            }
            
            // Read and parse the file
            const fileContent = fs.readFileSync(this.savePath, 'utf8').trim();
            
            // Handle empty file
            if (!fileContent) {
                logger.info('[GameStateManager] Saved games file is empty, starting fresh');
                this.games = new Map();
                this.saveGames();
                return true;
            }
            
            // Parse the JSON data
            const data = JSON.parse(fileContent);
            
            // Validate the data structure
            if (data && typeof data === 'object' && !Array.isArray(data)) {
                this.games = new Map(Object.entries(data));
                logger.info(`[GameStateManager] Loaded ${this.games.size} games from disk`);
                return true;
            } else {
                throw new Error('Invalid game data format');
            }
        } catch (error) {
            logger.error(`[GameStateManager] Error loading games: ${error.message}`);
            
            // Backup the corrupted file
            try {
                const backupPath = `${this.savePath}.${Date.now()}.bak`;
                if (fs.existsSync(this.savePath)) {
                    fs.renameSync(this.savePath, backupPath);
                    logger.warn(`[GameStateManager] Backed up corrupted games file to ${backupPath}`);
                }
            } catch (backupError) {
                logger.error(`[GameStateManager] Failed to backup corrupted games file: ${backupError.message}`);
            }
            
            // Start fresh
            this.games = new Map();
            this.saveGames();
            return false;
        }
    }

    saveGames() {
        const data = {};
        for (const [userId, gameData] of this.games.entries()) {
            // Get the current FEN from the game instance if it exists, otherwise use the saved FEN
            const currentFen = gameData.gameInstance ? gameData.gameInstance.fen() : gameData.fen;
            
            data[userId] = {
                fen: currentFen,
                playerColor: gameData.playerColor,
                opponent: gameData.opponent,
                threadId: gameData.threadId,
                difficulty: gameData.difficulty || 'medium'
            };
            
            // Update the in-memory FEN to match the game instance
            if (gameData.gameInstance) {
                gameData.fen = currentFen;
            }
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

    loadGames() {
        if (!fs.existsSync(this.savePath)) {
            logger.info('[GameStateManager] No saved games found');
            // Initialize with an empty object if file doesn't exist
            fs.writeFileSync(this.savePath, '{}');
            return;
        }

        try {
            const fileContent = fs.readFileSync(this.savePath, 'utf8').trim();
            // If file is empty, initialize it with an empty object
            if (!fileContent) {
                logger.info('[GameStateManager] Empty games file, initializing with empty object');
                fs.writeFileSync(this.savePath, '{}');
                return;
            }
            
            const data = JSON.parse(fileContent);
            // If data is not an object, initialize with empty object
            if (typeof data !== 'object' || data === null) {
                logger.warn('[GameStateManager] Invalid games data, initializing with empty object');
                fs.writeFileSync(this.savePath, '{}');
                return;
            }
            
            logger.info(`[GameStateManager] Loading ${Object.keys(data).length} games from disk`);
            for (const [userId, gameData] of Object.entries(data)) {
                if (!gameData || typeof gameData !== 'object') {
                    logger.warn(`[GameStateManager] Skipping invalid game data for user ${userId}`);
                    continue;
                }
                
                // Create a new Chess instance with the saved FEN
                const gameInstance = new Chess();
                try {
                    if (gameData.fen) {
                        gameInstance.load(gameData.fen);
                    }
                } catch (error) {
                    logger.error(`[GameStateManager] Error loading FEN for user ${userId}: ${error.message}`);
                    continue;
                }
                
                this.games.set(userId, {
                    fen: gameData.fen,
                    playerColor: gameData.playerColor,
                    opponent: gameData.opponent,
                    threadId: gameData.threadId,
                    difficulty: gameData.difficulty || 'intermediate',
                    gameInstance: gameInstance
                });
                
                logger.info(`[GameStateManager] Loaded game for user ${userId} with FEN: ${gameData.fen}`);
            }
            logger.info(`[GameStateManager] Loaded ${this.games.size} games`);
        } catch (error) {
            logger.error(`[GameStateManager] Error loading games: ${error.message}`);
        }
    }

    getGame(userId) {
        const gameData = this.games.get(userId);
        if (!gameData) return null;
        
        // If we have a game instance, make sure it's up to date
        if (gameData.gameInstance) {
            return gameData;
        }
        
        // If we have a FEN but no game instance, create one
        if (gameData.fen) {
            try {
                const gameInstance = new Chess();
                gameInstance.load(gameData.fen);
                gameData.gameInstance = gameInstance;
                logger.info(`[GameStateManager] Created new game instance for user ${userId} from FEN`);
            } catch (error) {
                logger.error(`[GameStateManager] Error creating game instance for user ${userId}: ${error.message}`);
                return null;
            }
        }
        
        return gameData;
    }

    getOpponentGame(userId) {
        const gameData = this.games.get(userId);
        if (!gameData || !gameData.opponent) return null;
        
        // This will ensure the game instance is created if it doesn't exist
        return this.getGame(gameData.opponent);
    }

    createGame(whiteId, blackId, difficulty = 'intermediate', initialFen = null) {
        logger.info(`[GameStateManager] Creating new game between ${whiteId} and ${blackId}`);
        
        if (this.hasExistingGame(whiteId, blackId)) {
            throw new Error('A game already exists between these players');
        }

        const fen = initialFen || 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
        
        // Create a new game instance
        const gameInstance = new Chess(fen);
        
        // Create the base game state
        const gameState = {
            fen: gameInstance.fen(),
            playerColor: 'w',
            opponent: blackId,
            threadId: null,
            difficulty,
            gameInstance
        };
        
        // Create entries for both players with correct colors
        const whiteGameState = { 
            ...gameState,
            playerColor: 'w',
            opponent: blackId
        };
        
        const blackGameState = { 
            ...gameState,
            playerColor: 'b',
            opponent: whiteId
        };
        
        this.games.set(whiteId, whiteGameState);
        this.games.set(blackId, blackGameState);
        
        this.saveGames();
        return whiteGameState; // Return the white player's game state by convention
    }

    updateGame(userId, updates) {
        const gameData = this.games.get(userId);
        if (!gameData) {
            throw new Error(`No game found for user ${userId}`);
        }


        // If we're updating the FEN, update the game instance if it exists
        if (updates.fen && gameData.gameInstance) {
            try {
                gameData.gameInstance.load(updates.fen);
                logger.debug(`[GameStateManager] Updated game instance FEN for user ${userId}`);
            } catch (error) {
                logger.error(`[GameStateManager] Error updating game instance FEN for user ${userId}: ${error.message}`);
                // Continue with the update even if we couldn't update the instance
            }
        }

        // Apply the updates
        Object.assign(gameData, updates);

        // Update the opponent's game data if needed
        if (updates.fen || updates.gameInstance) {
            const opponentData = this.games.get(gameData.opponent);
            if (opponentData) {
                // Update FEN if it was changed
                if (updates.fen) {
                    opponentData.fen = updates.fen;
                }
                
                // Share the game instance if it was updated
                if (updates.gameInstance) {
                    opponentData.gameInstance = updates.gameInstance;
                }
            }
        }

        this.saveGames();
        return gameData;
    }

    removeGame(userId) {
        const gameData = this.games.get(userId);
        if (gameData) {
            const opponentId = gameData.opponent;
            
            // Clean up game instances
            if (gameData.gameInstance) {
                // No explicit cleanup needed for Chess.js instances
                delete gameData.gameInstance;
            }
            
            // Remove the game data
            this.games.delete(userId);
            
            // Clean up opponent's game data if it exists
            if (opponentId) {
                const opponentData = this.games.get(opponentId);
                if (opponentData?.gameInstance) {
                    delete opponentData.gameInstance;
                }
                this.games.delete(opponentId);
            }
            
            this.saveGames();
            return true;
        }
        return false;
    }

    hasExistingGame(player1, player2) {
        const player1Game = this.games.get(player1);
        const player2Game = this.games.get(player2);
        return (player1Game?.opponent === player2) || (player2Game?.opponent === player1);
    }
}

// Export singleton instance
const gameStateManager = new GameStateManager(path.join(__dirname, 'games.json'));
module.exports = gameStateManager;
