const { logConversationContext } = require('./loggingUtils');
const logger = require('./logger');

/**
 * Generates a response using the OpenAI API
 * @param {Object} openai - The OpenAI API client
 * @param {Array} messages - The conversation messages
 * @param {Object} options - Generation options
 * @returns {Promise<string>} The generated response
 */
async function generateResponse(openai, messages, options = {}) {
    const {
        model = 'ft:gpt-4.1-2025-04-14:personal:rolybot:BOJYk0lB',
        temperature = 0.7,
        maxTokens = 600
    } = options;

    try {
        const response = await openai.chat.completions.create({
            model,
            messages,
            temperature,
            max_tokens: maxTokens
        });
        
        return response.choices[0].message.content.trim();
    } catch (error) {
        logger.error('Error generating response:', error);
        throw error;
    }
}

/**
 * Refines a response using the OpenAI API
 * @param {Object} openai - The OpenAI API client
 * @param {Object} params - Refinement parameters
 * @returns {Promise<{candidate: string, feedback: string}>} The refined response and feedback
 */
async function refineResponse(openai, params) {
    const {
        model = 'gpt-4o-mini',
        promptMessages,
        candidate,
        attempt,
        maxAttempts
    } = params;

    try {
        const refinement = await generateResponse(openai, [
            ...promptMessages,
            { role: 'assistant', content: candidate },
            { 
                role: 'user', 
                content: `Please provide feedback on this response (attempt ${attempt}/${maxAttempts}). ` +
                        `Focus on clarity, relevance, and helpfulness.`
            }
        ], { model });

        return {
            candidate,
            feedback: refinement
        };
    } catch (error) {
        logger.error('Error refining response:', error);
        return { candidate, feedback: 'Error generating feedback' };
    }
}

/**
 * Generates and refines a response with multiple attempts if needed
 * @param {Object} openai - The OpenAI API client
 * @param {Array} contextMessages - The conversation context
 * @param {Object} options - Generation and refinement options
 * @returns {Promise<string>} The best response
 */
async function generateAndRefineResponse(openai, contextMessages, options = {}) {
    const {
        maxRetryAttempts = 1,
        model = 'ft:gpt-4.1-2025-04-14:personal:rolybot:BOJYk0lB',
        refineModel = 'gpt-4o-mini',
        temperature = 0.7,
        maxTokens = 600
    } = options;

    const maxAttempts = Math.max(1, maxRetryAttempts);
    let bestReply = null;
    let feedbackHistory = [];
    let previousCandidates = [];

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        // Log the conversation context
        logConversationContext(contextMessages, {
            attempt,
            totalAttempts: maxAttempts,
            model,
            previousCandidates
        });

        // If refinement is disabled, generate and return the response
        if (maxRetryAttempts <= 0) {
            bestReply = await generateResponse(openai, contextMessages, { 
                model,
                temperature,
                maxTokens 
            });
            logger.info(`Generated response (refinement disabled):\n${bestReply}`);
            return bestReply;
        }

        try {
            // Generate response with current context
            const candidate = await generateResponse(openai, contextMessages, { 
                model,
                temperature,
                maxTokens 
            });
            logger.info(`Candidate (attempt ${attempt}):\n${candidate}`);

            // If this is the last attempt, return the best candidate
            if (attempt >= maxAttempts) {
                return candidate;
            }

            // Otherwise, refine the response
            const { candidate: refined, feedback } = await refineResponse(openai, {
                model: refineModel,
                promptMessages: contextMessages,
                candidate,
                attempt,
                maxAttempts
            });

            previousCandidates.push({ candidate, feedback });
            bestReply = refined;

        } catch (error) {
            logger.error(`Error in attempt ${attempt}:`, error);
            
            if (attempt === maxAttempts && bestReply === null) {
                return "I'm sorry, I encountered an error while generating a response. Please try again.";
            }
        }
    }

    return bestReply || "I'm sorry, I couldn't generate a response. Please try again.";
}

module.exports = {
    generateResponse,
    refineResponse,
    generateAndRefineResponse
};
