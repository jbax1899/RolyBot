const { openai } = require('./openaiHelper');
const logger = require('./logger');

const CLASSIFIER_MODEL = 'gpt-4o-mini';
const MIN_MESSAGE_LENGTH = 3;

/**
 * Classifies a message to determine if the bot should respond and how
 * @param {Object} messageData - Message data object
 * @param {string} messageData.content - The message content
 * @param {string} messageData.author - The author's username
 * @param {boolean} messageData.isBot - Whether the author is a bot
 * @param {boolean} messageData.isReply - Whether this is a reply to another message
 * @param {Array} messageData.messageHistory - Array of recent messages in the channel
 * @param {Array<Object>} legalMoves - Array of legal moves in the current position
 * @returns {Promise<Object>} Classification result
 */
async function classifyMessage({ content, author, isBot, isReply, messageHistory = [], legalMoves = [] }) {
    // Is it a chess command?
    // Chess move detection, algebraic (SAN) only: e.g. e4, Nf3, O-O, Qxe5, etc.
    const algebraicRegex = /^(O-O(-O)?|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](=[QRBN])?[+#]?)$/i;
    const trimmed = content.trim();
    
    // Check for direct chess moves first (fast path)
    if (algebraicRegex.test(trimmed)) {
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
    
    // Don't classify if message is too short
    if (trimmed.length < MIN_MESSAGE_LENGTH) {
        logger.info(`Message too short to classify (${trimmed.length} < ${MIN_MESSAGE_LENGTH}): "${trimmed}"`);
        return { respond: false };
    }

    // List of available chess commands for the LLM to use in its output
    const chessCommands = [
        { command: "start", description: "Start a new chess game with the bot." },
        { command: "resign", description: "Resign from your current chess game." },
        { command: "move", description: "Make a chess move. Accepts algebraic notation (SAN) or plain English (e.g., 'e4', 'knight to f3')." }
    ];

    // Format message history for context
    const contextMessages = messageHistory
        .filter(m => m.content.trim().length > 0)
        .slice(-4) // Only take last 4 messages to avoid too much context
        .map(m => `${m.isBot ? 'BOT' : 'USER'} ${m.author}: ${m.content}`);

    // Log message history for debugging
    const historyLog = `Message History (${messageHistory?.length || 0}):\n` +
        (messageHistory?.map((m, i) => 
            `  ${i + 1}. ${m.isBot ? 'BOT' : 'USER'} ${m.author}: ${m.content.substring(0, 50)}${m.content.length > 50 ? '...' : ''}`
        ).join('\n') || 'No message history');
    logger.info(historyLog);

    // 3. Generate the prompt
    const prompt = `You are a Discord bot classifier. Given a Discord message and its context, decide how the bot should respond.

Instructions:
- If the bot should reply with a message, include "respond": true and "message": true.
- You are in a chatroom with many human participants and some other bots, so pay attention to who is being addressed. If you (rolybot) are addressed/pinged you must always respond. If you are not being directly addressed you may NOT respond. 
- If relevant, react with emotes by including "respond": true and "emotes": [array of valid Unicode emoji or Discord custom emoji in the format "<:name:id>"]. You may prefer to use emoji reactions instead of a message.
- If the bot should not respond in any manner, return only { "respond": false }. If unsure, do not respond.
- If the message is a chess move (either algebraic notation like "e4", "Nf3", or plain English like "knight to e4", "castle kingside"), include "respond": true and a chess command of "move" with the move as the value (in SAN).
- When interpreting chess moves in plain English, use the provided legal moves to match the intended move. For example, if the user says "knight to f3" and the legal moves include "Nf3", use that exact notation.
- If the user wants to start a new chess game, resign, or make any other chess command, append it as an object in the "chess_commands" array. Each object should be one of:
  - { "command": "start" }
  - { "command": "resign" }
  - { "command": "move", "move": "e4" } (or any other valid move in SAN)
- If the user wants to chain multiple chess commands (e.g., "resign and start a new game"), include them all in order in the "chess_commands" array.

Available chess commands:
${chessCommands.map(cmd => `- ${cmd.command}: ${cmd.description}`).join("\n")}

Current legal chess moves:
${legalMoves.length > 0 ? legalMoves.map(move => `- ${move.uci}: ${move.san} (${move.piece} ${move.from} to ${move.to}${move.captured ? `, captures ${move.captured}` : ''}${move.promotion ? `, promotes to ${move.promotion}` : ''})`).join("\n") : 'No legal moves available'}

Return a JSON object with your classification. Example responses:
- { "respond": false }
- { "respond": true, "message": true }
- { "respond": true, "emotes": ["😄"] }
- { "respond": true, "message": true, "emotes": ["😄"] }
- { "respond": true, "chess_commands": [ { "command": "move", "move": "e4" } ] }
- { "respond": true, "chess_commands": [ { "command": "resign" }, { "command": "start" } ] }
- { "respond": true, "chess_commands": [ { "command": "move", "move": "Nf3" } ] } (for standard notation)
- { "respond": true, "chess_commands": [ { "command": "move", "move": "g1f3" } ] } (for UCI notation)

Recent conversation context (most recent last):
${contextMessages ? contextMessages : '(No recent messages)'}

The message you are classifying is from ${isBot ? 'BOT' : 'USER'} ${author}: "${content}"`;

    const resp = await openai.chat.completions.create({
        model: CLASSIFIER_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.0
    });

    try {
        const rawResponse = resp.choices[0]?.message?.content;
        if (!rawResponse) {
            throw new Error('No content in response');
        }
        
        logger.info('Raw classifier response:\n' + rawResponse);
        
        const parsed = JSON.parse(rawResponse);
        logger.info('Parsed classifier response:\n' + JSON.stringify(parsed, null, 2));
        
        return parsed;
    } catch (e) {
        const errorDetails = `Error: ${e.message}\n` +
            `Response Type: ${typeof resp.choices?.[0]?.message?.content}\n` +
            `Response Content: ${JSON.stringify(resp.choices?.[0]?.message?.content)}\n` +
            `Choices Length: ${resp.choices?.length || 0}`;
            
        logger.error('Failed to process classifier response:\n' + errorDetails);
        return { respond: false };
    }
}

module.exports = { classifyMessage };