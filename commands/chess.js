const gameManager = require('../utils/chess/gameManager');
const { Game } = require('../utils/chess/gameManager');
const logger = require('../utils/logger');
const threadManager = require('../utils/chess/threadManager');
const { replyWithThreadLink } = require('../utils/chess/threadManager');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const { AttachmentBuilder } = require('discord.js');

module.exports = {
    name: 'chess',
    description: `Play chess with the bot.
                    • start - Start a new game with RolyBot.
                    • resign - Resign from your current game.`,
    execute: async (message, args) => {
        try {
            const userId = message.author.id;
            // Ensure the user's thread exists for all chess actions
            // Handle different commands
            switch (args[0]?.toLowerCase()) {
                case 'start':
                    await startGame(message, userId);
                    break;
                case 'resign':
                    await resignGame(message, userId);
                    break;
                case 'show':
                    await showBoard(message, userId);
                    break;
                default:
                    await moveGame(message, args, userId);
            }
        } catch (error) {
            message.channel.send('⚠️ An error occurred.');
            logger.error(`Error in chess command: ${error.message}`);
        }
    },
};

// Accepts either a Message or a ThreadChannel as the first argument
async function showBoard(target, userId, msg = '') {
    let thread;
    // If it's a ThreadChannel (has .send and .type), use it directly
    if (target && typeof target.send === 'function' && typeof target.type !== 'undefined') {
        thread = target;
    } else {
        // Otherwise, assume it's a Message and get the thread
        thread = await threadManager.ensureGameThread(target.client, target, userId);
    }
    const game = gameManager.getGame(userId);
    if (!game) {
        await thread.send('No active game to show. Start one with `!rb chess start`.');
        return;
    }
    const fen = game.board.fen();
    const boardImageUrl = getBoardImageUrl(fen);

    const response = await fetch(boardImageUrl);
    if (!response.ok) {
        await thread.send('Failed to fetch board image.');
        return;
    }

    const contentType = response.headers.get('content-type');
    if (!contentType || !contentType.startsWith('image/')) {
        logger.error(`Board image fetch failed. Content-Type: ${contentType}`);
        await thread.send('Failed to fetch a valid board image (service error).');
        return;
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const attachment = new AttachmentBuilder(buffer, { name: 'board.png' });
    const threadResponse = await thread.send({
        content: msg,
        files: [attachment],
    });
    // If the original target was a Message, send a link
    if (target && target.id && target.channel && target.author) {
        await replyWithThreadLink(target, thread, threadResponse);
    }
}

// Function to handle starting a new game
async function startGame(message, userId) {
    const thread = await threadManager.ensureGameThread(message.client, message, userId);
    if (gameManager.games.has(userId)) {
        await showBoard(message, userId, 'You already have an active game. You must resign before starting a new one.');
        return;
    }
    // Randomly assign player color
    const playerColor = Math.random() < 0.5 ? 'w' : 'b';
    gameManager.games.set(userId, new Game(playerColor));
    gameManager.saveGames();
    if (playerColor === 'b') {
        // Bot plays first move as white
        await thread.sendTyping();
        let typingInterval = setInterval(() => {
            thread.sendTyping().catch(() => {});
        }, 5000);
        let aiMoveObj;
        try {
            aiMoveObj = await gameManager.makeAIMove(userId);
        } finally {
            clearInterval(typingInterval);
        }
        // Show the board from Black's perspective, but using the real FEN (not flipped before move)
        await showBoard(message, userId, `New game started! You are black. I'll play ${aiMoveObj ? aiMoveObj.san : 'unknown'}. Your turn!`);
    } else {
        await showBoard(message, userId, `New game started! You are white - What's your move?`);
    }
}

// Function to handle a resignation
async function resignGame(message, userId) {
    const thread = await threadManager.ensureGameThread(message.client, message, userId);
    if (gameManager.games.has(userId)) {
        gameManager.games.delete(userId);
        gameManager.saveGames();
        await showBoard(message, userId, 'You resigned. Game over.');
    } else {
        await showBoard(message, userId, 'You have no active game to resign.');
    }
}

// Function to handle a move
const { resolveMoveWithLLM, CHESS_MOVE_PARSER_MODEL } = require('../utils/chess/moveParser');

async function moveGame(message, args, userId) {
    if (!message || !message.channel) {
        logger.error('[moveGame] Invalid message or missing channel:', message);
        throw new Error('Cannot process move: message or channel is undefined.');
    }

    const thread = await threadManager.ensureGameThread(message.client, message, userId);
    const game = gameManager.getGame(userId);
    if (!game) {
        await showBoard(message, userId, 'No active game to move in.');
        return;
    }
    // Only allow move if it's the player's turn
    const isPlayersTurn = (game.playerColor === 'w' && game.board.turn() === 'w') || (game.playerColor === 'b' && game.board.turn() === 'b');
    if (!isPlayersTurn) {
        await showBoard(message, userId, "It's not your turn!");
        return;
    }
    // Parse the move from the user's input
    const moveInput = args.join(' ').trim();
    const legalMoves = game.board.moves({ verbose: true });
    // 1. Direct match for legal SAN or UCI
    const isLegalSAN = legalMoves.some(m => m.san.toLowerCase() === moveInput.toLowerCase());
    const isLegalUCI = legalMoves.some(m => (m.from + m.to + (m.promotion || '')).toLowerCase() === moveInput.toLowerCase());

    let moveToPlay = moveInput;
    if (isLegalSAN || isLegalUCI) {
        // It's a legal move, proceed as normal
    } else if (!isUciMove(moveInput)) {
        // Not UCI, try to resolve with LLM
        moveToPlay = await resolveMoveWithLLM(moveInput, legalMoves, game.board.fen());
        if (!moveToPlay) {
            await showBoard(message, userId, 'Sorry, I could not interpret your move. Please use standard notation or try to be more specific.');
            return;
        }
    }
    try {
        // Try the player's move first
        const playerMoveObj = await gameManager.makeMove(userId, moveToPlay);
        // Now, AI move in a separate try/catch
        await thread.sendTyping();
        let typingInterval = setInterval(() => {
            thread.sendTyping().catch(() => {});
        }, 5000);
        let aiMoveObj;
        try {
            aiMoveObj = await gameManager.makeAIMove(userId);
        } catch (aiError) {
            clearInterval(typingInterval);
            logger.error(`[Chess] AI move failed: ${aiError.message}`);
            await showBoard(message, userId, `You played: ${playerMoveObj ? playerMoveObj.san : moveToPlay}\nBut I couldn't make a move: ${aiError.message}`);
            return;
        }
        clearInterval(typingInterval);
        await showBoard(message, userId, `You played: ${playerMoveObj ? playerMoveObj.san : moveToPlay}\nI'll play: ${aiMoveObj ? aiMoveObj.san : 'unknown'}`);
    } catch (error) {
        if (error.message && error.message.toLowerCase().includes('no active game')) {
            await showBoard(message, userId, 'Are you wanting to play chess with me? If so, you can start a game with `!rb chess start`');
            return;
        }
        else if (error.message && error.message.toLowerCase().includes('invalid move')) {
            await showBoard(message, userId, 'That move is illegal.');
            return;
        }
        else if (error.message) {
            logger.warn(`[Chess] Move failed: ${error.message}`);
        }
        await showBoard(message, userId, 'Invalid move. Please try again.');
    }
}

function isUciMove(str) {
    // UCI: e2e4, g1f3, a7a8q, etc.
    return /^[a-h][1-8][a-h][1-8][qrbn]?$/i.test(str.trim());
}

function getBoardImageUrl(fen) {
    return `https://fen2png.com/api/?fen=${encodeURIComponent(fen)}&raw=true`;
}

module.exports.moveGame = moveGame;
module.exports.startGame = startGame;
module.exports.resignGame = resignGame;
module.exports.showBoard = showBoard;