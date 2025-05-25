const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
    name: 'help',
    data: new SlashCommandBuilder()
        .setName('help')
        .setDescription('Show help menu'),
    async execute(ctx, ...args) {
        const isInteraction = ctx.isCommand && typeof ctx.isCommand === 'function' ? ctx.isCommand() : ctx.commandName !== undefined;
        const interaction = isInteraction ? ctx : null;
        const message = !isInteraction ? ctx : null;
        const commandList = Object.keys(commands)
            .map(cmd => `!rb ${cmd} - ${commands[cmd].description || ''}`);
        const embed = new EmbedBuilder()
            .setTitle('===Help Page===')
            .setColor(0x00FF00)
            .setDescription(commandList.join('\n'));
        try {
            if (interaction) {
                await interaction.reply({ embeds: [embed], flags: 64 });
            } else if (message) {
                await message.channel.send({ embeds: [embed] });
            }
        } catch (error) {
            if (interaction) {
                await interaction.reply({ content: '⚠️ An error occurred while displaying the help message.', flags: 64 });
            } else if (message) {
                await message.channel.send('⚠️ An error occurred while displaying the help message.');
            }
        }
    }
};