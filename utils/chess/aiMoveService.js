/**
 * Service for handling AI moves in chess games using Stockfish engine.
 * Handles move generation, difficulty levels, and game state management.
 */

const { Engine } = require('node-uci');
const path = require('path');
const logger = require('../logger');
const { Chess } = require('chess.js');

const DIFFICULTY_LEVELS = {
    beginner: {
        skill: 0,      // 0-20 (Stockfish skill level)
        depth: 1,      // Search depth
        time: 100,     // Max thinking time in ms
        randomize: 0.3 // Chance to make a random move (0-1)
    },
    intermediate: {
        skill: 5,
        depth: 5,
        time: 500,
        randomize: 0.2
    },
    advanced: {
        skill: 10,
        depth: 10,
        time: 1000,
        randomize: 0.1
    },
    master: {
        skill: 15,
        depth: 15,
        time: 2000,
        randomize: 0
    }
};

const DEFAULT_DIFFICULTY = 'intermediate';

class AIMoveService {
    constructor() {
        this.difficulty = DEFAULT_DIFFICULTY;
    }

    _getStockfishPath() {
        if (process.env.STOCKFISH_PATH) {
            return process.env.STOCKFISH_PATH;
        }
        
        const platform = process.platform;
        if (platform === 'win32') {
            return path.join(__dirname, '../../stockfish/stockfish-windows/stockfish-windows-x86-64-avx2.exe');
        }
        
        // On Linux/macOS, rely on system PATH
        return 'stockfish';
    }

    async _getBestMove(fen, difficulty = this.difficulty) {
        const settings = typeof difficulty === 'string' 
            ? { ...DIFFICULTY_LEVELS[difficulty] || DIFFICULTY_LEVELS[DEFAULT_DIFFICULTY] }
            : { ...difficulty };

        logger.info(`[AIMoveService] Getting best move for ${fen} at difficulty: ${JSON.stringify(settings)}`);
        
        const engine = new Engine(this._getStockfishPath());
        
        try {
            await engine.init();
            await engine.isready();
            
            // Set up the engine with our difficulty settings
            await engine.setoption('Skill Level', settings.skill);
            
            // Set position
            await engine.position(fen);
            
            // Get the best move
            const result = await engine.go({
                depth: settings.depth,
                movetime: settings.time
            });
            
            if (!result || !result.bestmove) {
                throw new Error('Stockfish did not return a move');
            }
            
            // Randomize move if configured (for lower difficulty levels)
            if (settings.randomize > 0 && Math.random() < settings.randomize) {
                try {
                    // Get legal moves using chess.js
                    const chess = new Chess(fen);
                    const moves = chess.moves({ verbose: true });
                    if (moves && moves.length > 0) {
                        const randomIndex = Math.floor(Math.random() * moves.length);
                        const randomMove = moves[randomIndex];
                        // Convert to UCI format
                        const uciMove = randomMove.promotion 
                            ? `${randomMove.from}${randomMove.to}${randomMove.promotion}`
                            : `${randomMove.from}${randomMove.to}`;
                        result.bestmove = uciMove;
                        logger.info(`[AIMoveService] Randomized move selected: ${result.bestmove}`);
                    }
                } catch (error) {
                    logger.warn(`[AIMoveService] Error getting legal moves for randomization: ${error.message}`);
                    // Continue with the original best move if randomization fails
                }
            }
            
            return {
                from: result.bestmove.substring(0, 2),
                to: result.bestmove.substring(2, 4),
                promotion: result.bestmove.length > 4 ? result.bestmove.substring(4) : undefined,
                ...result
            };
            
        } catch (error) {
            logger.error(`[AIMoveService] Error getting best move: ${error.message}`);
            throw error;
        } finally {
            try { 
                await engine.quit(); 
            } catch (e) {
                logger.error('[AIMoveService] Error quitting engine:', e);
            }
        }
    }

    setDifficulty(difficulty) {
        if (DIFFICULTY_LEVELS[difficulty]) {
            this.difficulty = difficulty;
            logger.info(`[AIMoveService] Set difficulty to: ${difficulty}`);
        } else {
            logger.warn(`[AIMoveService] Invalid difficulty level: ${difficulty}. Using default.`);
        }
        return this;
    }

    async makeAIMove(game, difficulty = this.difficulty) {
        try {
            if (!game) {
                throw new Error('Invalid game instance: game is undefined');
            }
            
            const fen = game.fen();
            logger.info(`[AIMoveService] Starting AI move for FEN: ${fen}`);
            
            // Get legal moves for debugging
            const legalMoves = game.moves({ verbose: true });
            logger.debug(`[AIMoveService] Legal moves: ${JSON.stringify(legalMoves.map(m => m.san))}`);
            
            if (legalMoves.length === 0) {
                logger.warn(`[AIMoveService] No legal moves available for FEN: ${fen}`);
                throw new Error('No legal moves available');
            }

            logger.info(`[AIMoveService] Getting best move at difficulty: ${difficulty}`);
            const bestMove = await this._getBestMove(fen, difficulty);
            
            if (!bestMove) {
                throw new Error('No move returned from Stockfish');
            }

            // Make the move on the game board
            const move = game.move({
                from: bestMove.from,
                to: bestMove.to,
                promotion: bestMove.promotion || 'q' // Default to queen promotion
            });

            if (!move) {
                logger.error(`[AIMoveService] Invalid move: ${JSON.stringify(bestMove)}`);
                throw new Error(`Invalid move: ${JSON.stringify(bestMove)}`);
            }

            logger.info(`[AIMoveService] Successfully made move: ${move.san}. New FEN: ${game.fen()}`);
            
            // Return the move object with additional game state
            return {
                move,
                fen: game.fen(),
                gameOver: game.isGameOver(),
                inCheck: game.inCheck(),
                inCheckmate: game.isCheckmate(),
                inDraw: game.isDraw(),
                inStalemate: game.isStalemate(),
                inThreefoldRepetition: game.isThreefoldRepetition(),
                insufficientMaterial: game.isInsufficientMaterial()
            };
            
        } catch (error) {
            logger.error(`[AIMoveService] Error in makeAIMove: ${error.message}`, error);
            throw error;
        }
    }

    getDifficultyLevels() {
        return DIFFICULTY_LEVELS;
    }

    getCurrentDifficulty() {
        return {
            level: this.difficulty,
            settings: { ...DIFFICULTY_LEVELS[this.difficulty] || {} }
        };
    }
}

// Export singleton instance and constants for direct access
const aiMoveService = new AIMoveService();
module.exports = {
    instance: aiMoveService,
    DIFFICULTY_LEVELS,
    DEFAULT_DIFFICULTY
};