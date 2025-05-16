// Uses OpenAI gpt-4o-mini to resolve ambiguous chess moves from user input given board context.
const { openai } = require('../openaiHelper');
const CHESS_MOVE_PARSER_MODEL = 'gpt-4o-mini';

/**
 * @param {string} userInput - The user's move input (plain English, SAN, etc)
 * @param {Array} legalMoves - Array of legal moves from chess.js ({san, from, to, promotion, piece, etc})
 * @param {string} fen - Current board FEN
 * @returns {Promise<string|null>} - The best-matching move (UCI or SAN), or null if none found
 */
async function resolveMoveWithLLM(userInput, legalMoves, fen) {
    // Prepare a compact list of legal moves in both SAN and UCI
    const movesList = legalMoves.map(m => {
        const uci = m.from + m.to + (m.promotion || '');
        return `${m.san} (${uci})`;
    }).join('\n');

    const prompt = `You are a chess move interpreter. Given the following legal moves (in SAN and UCI), and a user's input, return the most likely legal move (UCI preferred, otherwise SAN). If you cannot confidently match, return null.

    Current FEN: ${fen}
    Legal moves:\n${movesList}
    User input: "${userInput}"
    Respond with only the best-matching move (UCI preferred, otherwise SAN), or null if no match is possible.`;

    const resp = await openai.chat.completions.create({
        model: CHESS_MOVE_PARSER_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.0
    });
    const text = resp.choices[0].message.content.trim();
    if (text.toLowerCase() === 'null') return null;
    // Clean up quotes if present
    return text.replace(/^"|"$/g, '');
}

module.exports = { resolveMoveWithLLM, CHESS_MOVE_PARSER_MODEL };
