const { EmbedBuilder } = require('discord.js');
const { commands } = require('../utils/commandLoader');

module.exports = {
    name: 'help',
    description: 'Displays this help message.',
    execute: async (message, args) => {
        try {
            const commandList = Object.keys(commands)
                .map(cmd => `!rb ${cmd} - ${commands[cmd].description}`);

            const embed = new EmbedBuilder()
                .setTitle('===Help Page===')
                .setColor(0x00FF00)
                .setDescription(commandList.join('\n'));

            await message.channel.send({ embeds: [embed] });
        } catch (error) {
            message.channel.send('⚠️ An error occurred while displaying the help message.');
        }
    }
};