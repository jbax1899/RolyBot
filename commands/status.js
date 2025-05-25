const { SlashCommandBuilder } = require('discord.js');
const { setPresence } = require('../utils/openaiHelper.js');

module.exports = {
    name: 'status',
    data: new SlashCommandBuilder()
        .setName('status')
        .setDescription('Update or show the bot status'),
    async execute(ctx, ...args) {
        const isInteraction = ctx.isCommand && typeof ctx.isCommand === 'function' ? ctx.isCommand() : ctx.commandName !== undefined;
        const interaction = isInteraction ? ctx : null;
        const message = !isInteraction ? ctx : null;
        try {
            const status = await setPresence(isInteraction ? interaction.client : message.client);
            if (interaction) {
                await interaction.reply({ content: `✅ Status updated to: **${status}**`, flags: 64 });
            } else if (message) {
                await message.reply(`✅ Status updated to: **${status}**`);
            }
        } catch (error) {
            if (interaction) {
                await interaction.reply({ content: '⚠️ An error occurred while updating the status.', flags: 64 });
            } else if (message) {
                await message.reply('⚠️ An error occurred while updating the status.');
            }
        }
    }
};