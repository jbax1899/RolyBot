const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const commands = {};

function loadCommands() {
    const commandFiles = fs.readdirSync(path.join(__dirname, '../commands'))
        .filter(file => file.endsWith('.js'));

    for (const file of commandFiles) {
        const command = require(`../commands/${file}`);
        commands[command.name] = command;
        logger.info(`Loaded command: ${command.name}`);
    }
}

function executeCommand(commandName, message, args) {
    const command = commands[commandName];
    if (!command) {
        message.channel.send(`Unknown command: \`${commandName}\``);
        return;
    }

    command.execute(message, args).catch(error => {
        logger.error(`Error executing ${commandName}:`, error);
        message.channel.send('⚠️ An error occurred while trying to execute the command.');
    });
}

module.exports = { loadCommands, executeCommand, commands };