const Chess = require('chess.js').Chess;
const logger = require('./logger');

class Game {
    constructor() {
        this.board = new Chess();
    }

    async getTurn() {
        const currentTurn = this.board.turn;
        if (currentTurn) return 'white';
        else return 'black';
    }

    async makeMove(move) {
        try {
            await this.board.move(move);
        } catch (error) {
            logger.error(`Error making move: ${error.message}`);
            throw new Error(`Invalid move: ${move}.`);
        }
    }
}

module.exports = Game;