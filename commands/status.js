const { setPresence } = require('../utils/openaiHelper');

module.exports = {
    name: 'status',
    description: 'Generates and sets a new status for the bot.',
    execute: async (message, args) => {
        try {
            const status = await setPresence(message.client);
            message.channel.send(`✅ Status updated to: **${status}**`);
        } catch (error) {
            message.channel.send('⚠️ An error occurred while updating the status.');
        }
    }
};