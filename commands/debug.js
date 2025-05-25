const { EmbedBuilder, SlashCommandBuilder } = require('discord.js');

module.exports = {
    name: 'debug',
    data: new SlashCommandBuilder()
        .setName('debug')
        .setDescription('Debug command for troubleshooting'),
    description: 'Shows bot diagnostics and last OpenAI usage stats.',
    execute: async (ctx, ...args) => {
        const isInteraction = ctx.isCommand && typeof ctx.isCommand === 'function' ? ctx.isCommand() : ctx.commandName !== undefined;
        const interaction = isInteraction ? ctx : null;
        const message = !isInteraction ? ctx : null;

        const uptimeSec = Math.floor(process.uptime());
        const memoryUsage = process.memoryUsage();

        const lines = [
            `⏱️ Uptime: ${uptimeSec}s`,
            `💾 Memory: ${(memoryUsage.rss / 1024 / 1024).toFixed(2)} MB RSS`,
            `🧠 Heap Used: ${(memoryUsage.heapUsed / 1024 / 1024).toFixed(2)} MB`,
        ];

        const embed = new EmbedBuilder()
            .setTitle('🛠️ Bot Debug Info')
            .setColor(0x3498db)
            .setDescription(lines.join('\n'));

        await message.channel.send({ embeds: [embed] });
    }
};