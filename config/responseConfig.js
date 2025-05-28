// Response generation configuration
module.exports = {
    // Model configurations
    models: {
        summary: 'gpt-4o-mini',
        primary: 'ft:gpt-4.1-2025-04-14:personal:rolybot:BOJYk0lB',
        refine: 'gpt-4o-mini'
    },
    
    // Token and history limits
    limits: {
        maxHistory: 20,
        maxRetryAttempts: 1,
        maxTotalTokens: 6000,
        reservedTokens: 500
    },
    
    // Generation parameters
    generation: {
        temperature: 0.7,
        maxTokens: 600
    }
};