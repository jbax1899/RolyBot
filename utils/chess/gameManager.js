const fs = require('fs');
const path = require('path');
const logger = require('../logger');
const Chess = require('chess.js').Chess;
const { getBestMove } = require('./stockfishEngine');

class Game {
    constructor(playerColor = 'w', thinkTimeSeconds = 5, fen = null) {
        this.board = fen ? new Chess(fen) : new Chess();
        this.thinkTimeSeconds = thinkTimeSeconds;
        this.playerColor = playerColor; // 'w' or 'b'
    }

    getTurn() {
        const currentTurn = this.board.turn;
        return currentTurn === 'w' ? 'white' : 'black';
    }

    makeMove(move) {
        if (!move || typeof move !== 'string') {
            logger.error(`[GameManager] Error making move: Move is undefined or not a string.`);
            throw new Error(`[GameManager] Invalid move: Move is undefined or not a string.`);
        }
        const result = this.board.move(move);
        if (!result) {
            logger.error(`[GameManager] Error making move: Invalid move: ${move}`);
            throw new Error(`[GameManager] Invalid move: ${move}`);
        }
        return result; // Return the move object (with SAN)
    }
}


const SAVE_PATH = path.join(__dirname, 'games.json');
const SAVE_DIR = path.dirname(SAVE_PATH);

class GameManager {
    constructor() {
        this.games = new Map();
        this.loadGames();
    }

    getGame(userId) {
        return this.games.get(userId);
    }

    setThinkTimeSeconds(userId, seconds) {
        const game = this.getGame(userId);
        if (game) {
            game.thinkTimeSeconds = seconds;
            this.saveGames();
        }
    }

    makeMove(userId, move) {
        const game = this.getGame(userId);
        if (!game) {
            throw new Error('No active game. Start one with !rb chess start.');
        }
        const moveObj = game.makeMove(move);
        this.saveGames();
        return moveObj;
    }

    // Asynchronously have the AI (Stockfish) make a move for this user
    async makeAIMove(userId) {
        const game = this.getGame(userId);
        if (!game) {
            throw new Error('No active game. Start one with !rb chess start.');
        }
        const fen = game.board.fen();
        const thinkTimeMs = (game.thinkTimeSeconds || 60) * 1000;
        try {
            const bestMove = await getBestMove(fen, thinkTimeMs);
            if (!bestMove) throw new Error('No move found by Stockfish');
            const moveObj = game.makeMove(bestMove);
            this.saveGames();
            return moveObj; // Return move object (with SAN)
        } catch (err) {
            logger.error(`[GameManager] Stockfish error for user ${userId}: ${err.message}`);
            throw err;
        }
    }

    getTurn(userId) {
        const game = this.getGame(userId);
        return game.getTurn();
    }

    saveGames() {
        const data = {};
        for (const [userId, game] of this.games.entries()) {
            data[userId] = {
                fen: game.board.fen(),
                playerColor: game.playerColor,
                thinkTimeSeconds: game.thinkTimeSeconds
            };
        }
        if (!fs.existsSync(SAVE_DIR)) {
            fs.mkdirSync(SAVE_DIR, { recursive: true });
        }
        fs.writeFileSync(SAVE_PATH, JSON.stringify(data, null, 2));
    }

    loadGames() {
        this.games = new Map();
        if (!fs.existsSync(SAVE_PATH)) return;
        try {
            const data = JSON.parse(fs.readFileSync(SAVE_PATH, 'utf8'));
            for (const userId of Object.keys(data)) {
                const { fen, playerColor, thinkTimeSeconds } = data[userId];
                this.games.set(userId, new Game(playerColor, thinkTimeSeconds, fen));
            }
            logger.info(`[GameManager] Loaded ${Object.keys(data).length} chess games from ${SAVE_PATH}`);
        } catch (err) {
            logger.error(`[GameManager] Failed to load games: ${err}`);
        }
    }
}

module.exports = Object.assign(new GameManager(), { Game });
