const { openai } = require('./openaiHelper');
const logger = require('./logger');

const CLASSIFIER_MODEL = 'gpt-4o-mini';
const MIN_MESSAGE_LENGTH = 3;

async function classifyMessage(message, lastBotMessageTs) {
    // Is it a chess command?
    // Chess move detection, algebraic (SAN) only: e.g. e4, Nf3, O-O, Qxe5, etc.
    const algebraicRegex = /^(O-O(-O)?|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](=[QRBN])?[+#]?)$/i;
    const trimmed = message.trim();
    if (algebraicRegex.test(trimmed)) {
        // Only shortcut for valid SAN moves
        return {
            respond: true,
            chess_commands: [ { command: 'move', move: trimmed } ]
        };
    }

    // Chess board display natural language triggers
    const showRegex = /^(show( me)?( the)? board|display( the)? board|show chess|chess board)$/i;
    if (showRegex.test(trimmed)) {
        return {
            respond: true,
            chess_commands: [ { command: 'show' } ]
        };
    }
    
    // Not a chess command, continue.
    // Don't classify if:
    if (
        message.length < MIN_MESSAGE_LENGTH
    ) {
        logger.info("Message too short to classify.");
        return { respond: false };
    }

    // List of available chess commands for the LLM to use in its output
    const chessCommands = [
        { command: "start", description: "Start a new chess game with the bot." },
        { command: "resign", description: "Resign from your current chess game." },
        { command: "move", description: "Make a chess move. Accepts algebraic notation (SAN) or plain English (e.g., 'e4', 'knight to f3')." }
    ];

    const prompt = `
        You are a Discord bot classifier. Given a Discord message, decide:
        - If the bot should not respond in any manner, return only { "respond": false }. If unsure, do not respond.
        - If the bot should reply with a message, include "respond": true and "message": true.
        - If the bot should react with emotes, include "respond": true and "emotes": [array of valid Unicode emoji or Discord custom emoji in the format "<:name:id>"].
        - If the message is a chess move (either algebraic notation like "e4", "Nf3", or plain English like "knight to e4", "castle kingside"), include "respond": true and a chess command of "move" with the move as the value (in SAN).
        - If the user wants to start a new chess game, resign, or make any other chess command, append it as an object in the "chess_commands" array. Each object should be one of:
        - { "command": "start" }
        - { "command": "resign" }
        - { "command": "move", "move": "e4" } (or whatever move the user specified)
        - If the user wants to chain multiple chess commands (e.g., "resign and start a new game"), include both in order in the "chess_commands" array.
        - The bot's last message was at timestamp: ${lastBotMessageTs} (current time: ${new Date().toISOString()}).
        - If the bot has replied recently (within the past few minutes), you should be less likely to reply with a message, unless the message is important or directly addressed to the bot.

        Available chess commands:
        ${chessCommands.map(cmd => `- ${cmd.command}: ${cmd.description}`).join("\n")}

        Return ONLY valid JSON in one of these formats:
        - { "respond": false }
        - { "respond": true, "message": true }
        - { "respond": true, "emotes": ["😄"] }
        - { "respond": true, "message": true, "emotes": ["😄"] }
        - { "respond": false, "chess_commands": [ { "command": "move", "move": "e4" } ] }
        - { "respond": false, "chess_commands": [ { "command": "resign" }, { "command": "start" } ] }

        Message: "${message}"`.trim();

    const resp = await openai.chat.completions.create({
        model: CLASSIFIER_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.0
    });

    try {
        return JSON.parse(resp.choices[0].message.content);
    } catch (e) {
        logger.error('Failed to parse classifier response:', e, resp.choices?.[0]?.message?.content);
        return { respond: false };
    }
}

module.exports = { classifyMessage };