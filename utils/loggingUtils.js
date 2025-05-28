const logger = require('./logger');

/**
 * Logs the conversation context in a structured format
 * @param {Array} messages - Array of message objects
 * @param {Object} metadata - Additional metadata for logging
 */
function logConversationContext(messages, metadata = {}) {
    const { attempt, totalAttempts, previousCandidates = [] } = metadata;
    const logOutput = [
        `\n===== MESSAGE CONTEXT (Attempt ${attempt}/${totalAttempts}) =====`,
        `Model: ${metadata.model || 'N/A'}`,
        `Previous Attempts: ${previousCandidates.length}`,
        ''
    ];

    // Log previous attempts if any
    if (previousCandidates.length > 0) {
        logOutput.push('=== PREVIOUS ATTEMPTS ===');
        previousCandidates.forEach((cand, i) => {
            logOutput.push(`--- ATTEMPT ${i + 1} ---\n${cand.candidate}\n\nFEEDBACK: ${cand.feedback}\n`);
        });
    }

    // Group messages by type
    const grouped = messages.reduce((acc, msg) => {
        const type = msg.role === 'system' ? 'system' : 
                    msg.role === 'assistant' ? 'assistant' : 'user';
        if (!acc[type]) acc[type] = [];
        acc[type].push(msg);
        return acc;
    }, {});

    // Log system messages
    if (grouped.system?.length) {
        logOutput.push('=== SYSTEM MESSAGES ===');
        grouped.system.forEach((msg, i) => {
            logOutput.push(`[System ${i}]\n${msg.content}\n`);
        });
    }

    // Log conversation in order
    if (grouped.user?.length || grouped.assistant?.length) {
        logOutput.push('=== CONVERSATION ===');
        messages
            .filter(m => m.role !== 'system')
            .forEach(msg => {
                logOutput.push(`[${msg.role.toUpperCase()}]\n${msg.content}\n`);
            });
    }

    logOutput.push('='.repeat(60));
    logger.info(logOutput.join('\n'));
}

module.exports = {
    logConversationContext
};
