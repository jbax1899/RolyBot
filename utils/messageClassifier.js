const { openai } = require('./openaiHelper');
const logger = require('./logger');

const CLASSIFIER_MODEL = 'gpt-4o-mini';
const MIN_MESSAGE_LENGTH = 3;

async function classifyMessage(message, lastBotMessageTs) {
    // Don't classify if:
    if (
        message.length < MIN_MESSAGE_LENGTH
    ) {
        logger.info("Message too short to classify.");
        return { respond: false };
    }

    const prompt = `
    You are a Discord bot classifier. Given a Discord message, decide:
    - Should the bot respond? (yes/no).
    - If the bot should reply with a message, include "message": true.
    - If the bot should react with emotes, include "emotes": [array of valid Unicode emoji or Discord custom emoji in the format "<:name:id>"].
    - If both, include both fields.
    - If the bot should not respond, return only { "respond": false }.
    - Do not use generic emoji names.
    - If unsure, do not respond.
    - The bot's last message was at timestamp: ${lastBotMessageTs} (current time: ${new Date().toISOString()}).
    - If the bot has replied recently (within the past few minutes), you should be less likely to reply with a message, unless the message is important or directly addressed to the bot.
    
    Return ONLY valid JSON in one of these formats:
    - { "respond": false }
    - { "respond": true, "message": true }
    - { "respond": true, "emotes": ["😄"] }
    - { "respond": true, "message": true, "emotes": ["😄"] }
    
    Message: "${message}"`.trim();

    const resp = await openai.chat.completions.create({
        model: CLASSIFIER_MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 128,
        temperature: 0.0
    });

    try {
        return JSON.parse(resp.choices[0].message.content);
    } catch (e) {
        logger.error('Failed to parse classifier response:', e);
        return { respond: false };
    }
}

module.exports = { classifyMessage };