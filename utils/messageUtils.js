/**
 * Fetches the last N messages from a channel and formats them
 * @param {Object} channel - Discord channel to fetch messages from
 * @param {number} limit - Maximum number of messages to fetch
 * @returns {Promise<Array>} Array of formatted message objects
 */
async function loadPosts(channel, limit = 20) {
    try {
        const messages = await channel.messages.fetch({ limit });
        const formatted = [];
        const botId = channel.client.user.id;

        for (const [id, message] of messages) {
            try {
                // Skip messages without content or from bots (except our own)
                if (!message.content || (message.author.bot && message.author.id !== botId)) {
                    continue;
                }

                formatted.push({
                    id: message.id,
                    content: message.content,
                    author: message.author.id,
                    username: message.author.username,
                    role: message.author.id === botId ? 'assistant' : 'user',
                    isBot: message.author.bot,
                    timestamp: message.createdTimestamp,
                    url: message.url
                });
            } catch (error) {
                console.error(`Error processing message ${message.id}:`, error);
            }
        }

        // Sort by timestamp (oldest first)
        return formatted.sort((a, b) => a.timestamp - b.timestamp);
    } catch (error) {
        console.error('Error loading posts:', error);
        return [];
    }
}

module.exports = {
    loadPosts
};
