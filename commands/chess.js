const game = require('../utils/chessHandler');
const logger = require('../utils/logger');

module.exports = {
    name: 'chess',
    description: `Play chess with the bot.
                    • start - Start a new game.
                    • resign - Resign from the current game.
                    • <move> - Make a move in the current game (plain english or chess notation)`,
    execute: async (message, args) => {
        try {
            // Handle different commands
            switch (args[0].toLowerCase()) {
                case 'start':
                    await startGame(message);
                    break;
                case 'resign':
                    await resignGame(message);
                    break;
                default:
                    await moveGame(message, args);
            }
        } catch (error) {
            message.channel.send('⚠️ An error occurred.');
            logger.error(`Error in chess command: ${error.message}`);
        }
    },
};

// Function to handle starting a new game
async function startGame(message) {
    // Get the current player (the user who triggered the command)
    const currentPlayer = await game.getTurn();

    message.channel.send(`New game started! You are ${currentPlayer} to move.`);
}

// Function to handle a resignation
async function resignGame(message) {
    // Get the current player (the user who triggered the command)
    const currentPlayer = await game.getTurn();

    message.channel.send(`You resigned as ${currentPlayer}. Game over.`);
}

// Function to handle a move
async function moveGame(message, args) {
    // Get the current player (the user who triggered the command)
    const currentPlayer = await game.getTurn();

    // Parse the move from the user's input
    const move = args.slice(1).join(' ');

    try {
        // Make the move on the board
        await game.makeMove(move);

        message.channel.send(`Made move: ${move}`);
    } catch (error) {
        message.channel.send('Invalid move. Please try again.');
    }
}
