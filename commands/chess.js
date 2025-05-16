const gameManager = require('../utils/chess/gameManager');
const { Game } = require('../utils/chess/gameManager');
const logger = require('../utils/logger');
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

async function showBoard(message, userId, msg = '') {
    const game = gameManager.getGame(userId);
    if (!game) {
        await message.channel.send('No active game to show. Start one with `!rb chess start`.');
        return;
    }
    const fen = game.board.fen();
    const boardImageUrl = getBoardImageUrl(fen);

    const response = await fetch(boardImageUrl);
    if (!response.ok) {
        await message.channel.send('Failed to fetch board image.');
        return;
    }

    const contentType = response.headers.get('content-type');
    if (!contentType || !contentType.startsWith('image/')) {
        logger.error(`Board image fetch failed. Content-Type: ${contentType}`);
        await message.channel.send('Failed to fetch a valid board image (service error).');
        return;
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const attachment = new AttachmentBuilder(buffer, { name: 'board.png' });
    await message.channel.send({
        content: msg,
        files: [attachment],
    });
}

// Function to handle starting a new game
async function startGame(message, userId) {
    if (gameManager.games.has(userId)) {
        message.channel.send('You already have an active game. You must resign before starting a new one.');
        return;
    }
    // Randomly assign player color
    const playerColor = Math.random() < 0.5 ? 'w' : 'b';
    gameManager.games.set(userId, new Game(playerColor));
    gameManager.saveGames();
    if (playerColor === 'b') {
        // Bot plays first move as white
        await message.channel.sendTyping();
        let typingInterval = setInterval(() => {
            message.channel.sendTyping().catch(() => {});
        }, 5000);
        let aiMoveObj;
        try {
            aiMoveObj = await gameManager.makeAIMove(userId);
        } finally {
            clearInterval(typingInterval);
        }
        // Show the board from Black's perspective, but using the real FEN (not flipped before move)
        await showBoard(message, userId, `New game started! You are black. Bot played: ${aiMoveObj ? aiMoveObj.san : 'unknown'}\nYour turn!`, true);
    } else {
        await showBoard(message, userId, `New game started! You are white - Make your move.`, false);
    }
}

// Function to handle a resignation
async function resignGame(message, userId) {
    if (gameManager.games.has(userId)) {
        gameManager.games.delete(userId);
        gameManager.saveGames();
        message.channel.send('You resigned. Game over.');
    } else {
        message.channel.send('You have no active game to resign.');
    }
}

// Function to handle a move
const { resolveMoveWithLLM, CHESS_MOVE_PARSER_MODEL } = require('../utils/chess/moveParser');

function isUciMove(str) {
    // UCI: e2e4, g1f3, a7a8q, etc.
    return /^[a-h][1-8][a-h][1-8][qrbn]?$/i.test(str.trim());
}

// Function to handle a move
async function moveGame(message, args, userId) {
    const game = gameManager.getGame(userId);
    if (!game) {
        await message.channel.send('No active game to move in.');
        return;
    }
    // Only allow move if it's the player's turn
    const isPlayersTurn = (game.playerColor === 'w' && game.board.turn() === 'w') || (game.playerColor === 'b' && game.board.turn() === 'b');
    if (!isPlayersTurn) {
        await message.channel.send("It's not your turn!");
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
            await message.channel.send('Sorry, I could not interpret your move. Please use standard notation or try to be more specific.');
            return;
        }
    }
    try {
        const playerMoveObj = await gameManager.makeMove(userId, moveToPlay);
        // While the AI is thinking, show typing...
        await message.channel.sendTyping();
        let typingInterval = setInterval(() => {
            message.channel.sendTyping().catch(() => {});
        }, 5000);
        let aiMoveObj;
        try {
            aiMoveObj = await gameManager.makeAIMove(userId);
        } finally {
            clearInterval(typingInterval);
        }
        // Respond with a single message including the player's move (SAN), bot's move (SAN), and the updated board image
        await showBoard(message, userId, `You played: ${playerMoveObj ? playerMoveObj.san : moveToPlay}\nI'll play: ${aiMoveObj ? aiMoveObj.san : 'unknown'}`);
    } catch (error) {
        // Always show the friendly message for no active game
        if (error.message && error.message.toLowerCase().includes('no active game')) {
            await message.channel.send('Are you wanting to play chess with me? If so, you can start a game with `!rb chess start`');
            return;
        }
        // Distinguish between illegal and other errors
        if (error.message && error.message.toLowerCase().includes('invalid move')) {
            await message.channel.send('That move is illegal.');
            return;
        }
        // Only show 'Invalid move' for other errors
        await message.channel.send('Invalid move. Please try again.');
    }
}

function getBoardImageUrl(fen) {
    return `https://fen2png.com/api/?fen=${encodeURIComponent(fen)}&raw=true`;
}

module.exports.moveGame = moveGame;
module.exports.startGame = startGame;
module.exports.resignGame = resignGame;
module.exports.showBoard = showBoard;