const fs = require('fs');
const path = require('path');
const { Collection, REST, Routes } = require('discord.js');
const logger = require('./logger');
const slashCommands = new Collection();

function loadCommands() {
    const commandFiles = fs.readdirSync(path.join(__dirname, '../commands'))
        .filter(file => file.endsWith('.js'));

    for (const file of commandFiles) {
        const command = require(`../commands/${file}`);
        if (command.data && command.data.name) {
            slashCommands.set(command.data.name, command);
            logger.info(`Loaded slash command: ${command.data.name}`);
        }
    }
}

function getSlashCommandDataArray() {
    return slashCommands.map(cmd => cmd.data.toJSON());
}

async function registerSlashCommands(clientId, token, guildId = null) {
    try {
        // Ensure commands are loaded first
        loadCommands();
        const rest = new REST({ version: '10' }).setToken(token);
        const commandData = getSlashCommandDataArray();
        
        logger.info('Started refreshing application (/) commands.');
        
        if (guildId) {
            // Register commands for a specific guild (faster updates for testing)
            await rest.put(
                Routes.applicationGuildCommands(clientId, guildId),
                { body: commandData },
            );
            logger.info(`Successfully reloaded ${commandData.length} guild (/) commands.`);
        } else {
            // Register commands globally (takes up to an hour to propagate)
            await rest.put(
                Routes.applicationCommands(clientId),
                { body: commandData },
            );
            logger.info(`Successfully registered ${commandData.length} global (/) commands.`);
        }
        
        return true;
    } catch (error) {
        logger.error('Error refreshing application (/) commands:', error);
        return false;
    }
}

module.exports = {
    loadCommands,
    slashCommands,
    getSlashCommandDataArray,
    registerSlashCommands
};