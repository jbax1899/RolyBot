const Chess = require('chess.js').Chess;
const logger = require('../logger');

/**
 * Returns a fen2png.com board image URL for the given FEN.
 * @param {string} fen - FEN string
 * @returns {Promise<string>} - fen2png.com board image URL
 */
async function getBoardImageUrl(fen) {
    try {
        if (!fen || typeof fen !== 'string') throw new Error('Invalid FEN string');
        const url = `https://fen2png.com/api/?fen=${encodeURIComponent(fen)}&raw=true`;
        logger.info(`[Game] Generated board image URL: ${url}`);
        return url;
    } catch (e) {
        logger.error(`[Game] Error generating board image URL: ${e.message}`);
        throw e;
    }
}

class Game {
    constructor(playerColor = 'w', difficulty = 'medium', fen = null) {
        this.board = fen ? new Chess(fen) : new Chess();
        this.difficulty = difficulty;
        this.playerColor = playerColor;
    }

    getTurn() {
        return this.board.turn() === 'w' ? 'white' : 'black';
    }

    makeMove(move) {
        if (!move || typeof move !== 'string') {
            throw new Error(`[Game] Invalid move: Move is undefined or not a string.`);
        }
        logger.info(`[Game] Current board FEN: ${this.board.fen()}`);
        logger.info(`[Game] Current turn: ${this.board.turn()}`);
        logger.info(`[Game] Trying to make move: ${move}`);
        const currentTurn = this.board.turn();
        if (currentTurn === 'w' && this.playerColor !== 'w') {
            throw new Error(`[Game] It's not your turn. It's White's turn.`);
        }
        if (currentTurn === 'b' && this.playerColor !== 'b') {
            throw new Error(`[Game] It's not your turn. It's Black's turn.`);
        }
        let result = this.board.move(move);
        if (!result) {
            logger.info(`[Game] SAN move failed, trying coordinate notation: ${move}`);
            const coordMove = move.replace(/([a-h])([1-8])([a-h])([1-8])/i, '$1$2-$3$4');
            logger.info(`[Game] Converted to coordinate move: ${coordMove}`);
            result = this.board.move(coordMove);
        }
        if (!result) {
            const legalMoves = this.board.moves({ verbose: true });
            logger.error(`[Game] Invalid move: ${move}`);
            logger.error(`[Game] Board state after failed move:`);
            logger.error(`[Game] FEN: ${this.board.fen()}`);
            logger.error(`[Game] Turn: ${this.board.turn()}`);
            logger.error(`[Game] Legal moves available:`);
            logger.error(`[Game] ${JSON.stringify(legalMoves, null, 2)}`);
            throw new Error(`[Game] Invalid move: ${move}`);
        }
        logger.info(`[Game] Successfully made move: ${move} (${result.san})`);
        return result;
    }
}

module.exports = {
    Game,
    getBoardImageUrl
};
