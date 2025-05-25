const { getBestMove } = require('./stockfishEngine');
const logger = require('../logger');
const { Game } = require('./game');

class AIMoveService {
    constructor() {
        this.thinkingTime = 2000; // Default thinking time in ms
    }

    /**
     * Make an AI move using Stockfish
     * @param {Game} game - Game instance
     * @param {string} userId - Discord user ID of the AI player
     * @returns {Promise<Object>} Move result
     */
    async makeAIMove(game, userId) {
        if (!game || !game.board) {
            throw new Error('Invalid game instance');
        }

        const fen = game.board.fen();
        logger.info(`[AIMoveService] Starting AI move for user ${userId}`);
        
        try {
            const bestMove = await getBestMove(fen, this.thinkingTime);
            if (!bestMove) {
                throw new Error('No move found by Stockfish');
            }

            logger.info(`[AIMoveService] AI (${userId}) making move: ${bestMove}`);
            const moveObj = game.makeMove(bestMove);
            
            if (!moveObj) {
                throw new Error('Failed to make AI move');
            }

            return moveObj;
        } catch (error) {
            logger.error(`[AIMoveService] Error in makeAIMove for user ${userId}: ${error.message}`);
            throw error;
        }
    }

    /**
     * Set the thinking time for the AI
     * @param {number} ms - Thinking time in milliseconds
     */
    setThinkingTime(ms) {
        if (typeof ms === 'number' && ms > 0) {
            this.thinkingTime = ms;
        }
    }
}

// Export singleton instance
const aiMoveService = new AIMoveService();
module.exports = aiMoveService;
