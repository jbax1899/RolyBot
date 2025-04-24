const { EmbedBuilder } = require('discord.js');

module.exports = {
    name: 'debug',
    description: 'Shows bot diagnostics and last OpenAI usage stats.',
    execute: async (message, args) => {
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