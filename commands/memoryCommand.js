const MemoryManager = require('../utils/memoryManager');
const logger = require('../utils/logger');

module.exports = {
    name: 'memory',
    description: 'Prints a summary of saved memories',
    execute: async (message, args) => {
        try {
            const memoryRetriever = MemoryManager.memoryRetriever;
            
            // Get memory summary
            const memories = memoryRetriever.memoryStore;
            
            // Create a summary message
            let summaryMessage = `**Memory Summary**\n`;
            summaryMessage += `Total Memories: ${memories.length}\n\n`;
            
            // Show details of first 5 memories (or all if less than 5)
            const displayCount = Math.min(5, memories.length);
            for (let i = 0; i < displayCount; i++) {
                const memory = memories[i];
                summaryMessage += `**Memory ${i + 1}:**\n`;
                summaryMessage += `- Timestamp: ${memory.timestamp ? new Date(memory.timestamp).toLocaleString() : 'Unknown'}\n`;
                summaryMessage += `- Content: ${memory.text ? memory.text.substring(0, 100) : 'No content'}${memory.text && memory.text.length > 100 ? '...' : ''}\n\n`;
            }
            
            // If more than 5 memories, indicate there are more
            if (memories.length > 5) {
                summaryMessage += `*... and ${memories.length - 5} more memories*`;
            }
            
            // Send the summary message
            await message.channel.send(summaryMessage);
        } catch (error) {
            logger.error('Error in memory command:', error);
            await message.channel.send('Failed to retrieve memory summary.');
        }
    }
};
