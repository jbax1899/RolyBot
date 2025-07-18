// Context Generators for RolyBot Response Generation
// This module breaks down the context generation process into modular, focused functions

const logger = require('./logger');
const path = require("path");
const fs = require("fs");
const contextPath = path.join(__dirname, "context.json");
const contextData = JSON.parse(fs.readFileSync(contextPath, "utf8"));
const openai = require('./openaiHelper');

/**
 * Generates the core system message that defines RolyBot's personality and behavior
 * @param {Date} [currentTime] - Optional time to use for the system message
 * @returns {Object} System message object for LLM
 */
function generateSystemMessage(currentTime = new Date()) {
    const nowLocal = currentTime.toLocaleString("en-US", {
        dateStyle: "full",
        timeStyle: "long"
    });

    return {
        role: 'system',
        content: `You are RolyBot, a helpful and friendly Discord bot who imitates its creator (RolyBug/jbax1899/Jordan).
                    You will be given a chat transcript, and you are to respond to the last (most recent) message - Previous messages are included for context, but you should not reference them unless it is relevant to the current message.
                    Write a long and thorough reply (aim for at least a few sentences). Do not cut your messages too short.
                    Avoid assistant-style language. Stay in character (always be yourself), and use common Discord emoji if appropriate.
                    Never prefix your responses with "RolyBot:" or anything similar.
                    If there is a websearch result included below, you MUST include that info, talk about it in detail, and always include any links (within brackets to prevent Discord from creating embeddings).
                    Do not reply to yourself.
                    Current date/time (Local): ${nowLocal}
                    `.replace(/\s+/g, ' ').trim()
    };
}

/**
 * Generates a summary of the most similar messages to provide context
 * @param {string} prompt - The current user prompt + extra context
 * @param {Object} memoryRetriever - Memory retrieval service
 * @param {Object} openai - OpenAI service for summarization
 * @param {string} [summaryModel='gpt-4o-mini'] - Model to use for summarization
 * @returns {Promise<Object|null>} Context message for similar messages, or null if no summary possible
 */
async function generateSimilarMessagesSummary(prompt, memoryRetriever, openai, summaryModel = 'gpt-4o-mini') {
    try {
        // Find the most relevant memories
        const similarMessages = await memoryRetriever.retrieveRelevantMemories(prompt);
        
        // If no similar messages found, return null
        if (!similarMessages || similarMessages.length === 0) return null;

        // Combine similar messages into a single text
        const similarMessagesText = similarMessages.map(m => m.text).join('\n\n');

        // Use OpenAI to generate a concise summary
        const summaryResponse = await openai.chat.completions.create({
            model: summaryModel,
            messages: [
                {
                    role: 'system',
                    content: 'Summarize the following messages concisely, preserving key context and tone. Focus on the most important information.'
                },
                {
                    role: 'user',
                    content: similarMessagesText
                }
            ],
            max_tokens: 150,
            temperature: 0.3
        });

        const summarizedText = summaryResponse.choices[0].message.content.trim();

        // Return the summary as a system message
        return {
            role: 'system',
            content: `SIMILAR MESSAGES SUMMARY:\n${summarizedText}`
        };
    } catch (err) {
        logger.error('[RolyBot] Failed to generate similar messages summary:', err);
        return null;
    }
}

/**
 * Generates a prompt to select function tokens that might enhance the response
 * @param {string} userPrompt - The original user prompt
 * @returns {Object[]} Prompt messages for token selection
 */
function generateTokenSelectorPrompt(userPrompt, discordUserId) {
    return [
        {
            role: 'system',
            content: `You are tasked with pre-processing a chatlog before it is fed into the main LLM call.
                If any of the below functions make sense to use, add them to your output.

                Available functions:

                [websearch="search query here"]
                - Only ONE websearch is allowed at most. Do not include more than one websearch function.
                - Include if the prompt asked you to do a web search, for recent news on something, or if extra information may be useful for you to answer (like real-time/current information).
                - Only apply to the immediate conversation topic.
                - Only include if there is a good reason to do so.
                - If looking for recent info, do not include a time period.
                - Example: [websearch="apple stock value"]

                [sleep="duration in seconds"]
                - Only ONE sleep is allowed at most. Do not include more than one sleep function.
                - Instructs the bot to stop responding to messages for the given amount of time, and then return to normal.
                - Keep duration under 5 minutes.

                [context="aboutBot"]
                - Include if extra information about yourself (RolyBot) would be useful.
                - Provides context about the bot, like its name, creator, creation date, features, commands, software stack, etc.

                [context="aboutRolybug"]
                - Include if extra information about Rolybug/Jordan/jbax1899 is required.
                - Provides context like who he is, what he likes, who his friends are, etc.

                [context="changelog"]
                - Include if extra information about recent changes to the bot's code/functionality would be useful.

                [chess="<discordUserId>"]
                - Use this to request a summary of the chess game for a Discord user. The ID of the current user is: ${discordUserId}
                - Example: [chess="${discordUserId}"]`
        },
        {
            role: 'user',
            content: userPrompt
        }
    ];
}

/**
 * Generates context from recent messages based on available token space
 * @param {Array} formattedHistory - Conversation history
 * @param {number} availableTokens - Number of tokens available for recent messages
 * @param {string} [similarMessagesSummary] - Optional summary to prevent duplicates
 * @returns {Object|null} Context message for recent messages, or null if no messages fit
 */
function generateRecentMessagesContext(formattedHistory, availableTokens, similarMessagesSummary = '') {
    if (availableTokens <= 100) {
        logger.warn(`[RolyBot] Insufficient tokens (${availableTokens}) to add recent context`);
        return null;
    }

    // Filter out messages already included in similar messages summary
    const usedMessageContents = new Set(
        similarMessagesSummary ? similarMessagesSummary.split('\n').map(line => line.trim()) : []
    );

    const recentMessages = formattedHistory
        .slice(-Math.floor(availableTokens / 50))
        .filter(msg => {
            const msgContent = `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`;
            const isDuplicate = usedMessageContents.has(msgContent);
            if (!isDuplicate) {
                usedMessageContents.add(msgContent);
            }
            return !isDuplicate;
        })
        .map(msg => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`);

    if (recentMessages.length === 0) return null;

    return {
        role: 'system',
        content: `RECENT CONTEXT (additional perspective):\n${recentMessages.join('\n')}`
    };
}

/**
 * Builds the full context array for the LLM call.
 * @param {Object} opts - Options for context generation.
 * @param {string} userPrompt
 * @param {Array} formattedHistory
 * @param {string} similarMessagesSummary
 * @param {number} maxTotalTokens
 * @param {number} reservedTokens
 * @returns {Array} genMessages
 */
function buildGenMessages({ userPrompt, formattedHistory, similarMessagesSummary, maxTotalTokens = 4000, reservedTokens = 500 }) {
    const calculateTokens = (msg) => msg.content ? msg.content.split(' ').length * 1.3 : 0;
    let genMessages = [generateSystemMessage()];

    if (similarMessagesSummary) {
        genMessages.push({
            role: 'system',
            content: `SIMILAR MESSAGES SUMMARY:\n${similarMessagesSummary}`
        });
    }

    const currentTokens = genMessages.reduce((total, msg) => total + calculateTokens(msg), 0);
    const availableTokens = maxTotalTokens - currentTokens - reservedTokens;

    if (availableTokens > 100) {
        const usedMessageContents = new Set(
            similarMessagesSummary ? similarMessagesSummary.split('\n').map(line => line.trim()) : []
        );

        const recentMessages = formattedHistory
            .slice(-Math.floor(availableTokens / 50))
            .filter(msg => {
                const msgContent = `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`;
                const isDuplicate = usedMessageContents.has(msgContent);
                if (!isDuplicate) {
                    usedMessageContents.add(msgContent);
                }
                return !isDuplicate;
            })
            .map(msg => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`);

        if (recentMessages.length > 0) {
            genMessages.push({
                role: 'system',
                content: `RECENT CONTEXT (additional perspective):\n${recentMessages.join('\n')}`
            });
        }
    }

    genMessages.push({ role: 'user', content: userPrompt });
    return genMessages;
}

/**
 * Injects context-grabbing function results into the context.
 * @param {object} args
 * @param {object} client - Discord client
 * @param {string} userPrompt
 * @param {object} openai - OpenAI instance
 * @param {string} SUMMARY_MODEL
 * @param {string} discordUserId - Discord user ID
 * @param {Function} goAFK - Function to set the bot as AFK
 * @returns {Promise<Array>} Array of context messages
 */
async function injectContextFunctionTokens({ client, userPrompt, openai, SUMMARY_MODEL, discordUserId, goAFK }) {
    // Use the LLM to select which special tokens to process
    const tokenSelectorPrompt = generateTokenSelectorPrompt(userPrompt, discordUserId);
    const tokenSelResp = await openai.chat.completions.create({
        model: SUMMARY_MODEL,
        messages: tokenSelectorPrompt,
        max_tokens: 64,
        temperature: 0.0
    });
    const tokenString = tokenSelResp.choices[0].message.content.trim();

    // Inline the special token processing logic
    const results = {};
    const TOKEN_REGEX = /\[(\w+)="([^"]+)"\]/g;
    const tokenHandlers = {
        websearch: handleWebSearch,
        search: handleWebSearch,
    };
    for (let [, type, content] of tokenString.matchAll(TOKEN_REGEX)) {
        if (type === "context") {
            if (!contextData[content]) {
                results[content] = `⚠️ No context found for "${content}"`;
            } else {
                results[content] = contextData[content];
            }
        }
        else if (type === "chess") {
            // content is the playerId
            const chessContext = generateChessContext(content);
            if (!chessContext) {
                results["chess"] = `⚠️ No chess game found for player "${content}"`;
            } else {
                results["chess"] = chessContext;
            }
        }
        else if (type === "sleep") {
            const seconds = parseInt(content, 10);
            if (isNaN(seconds) || seconds <= 0) {
                logger.warn(`⚠️ Invalid sleep duration: "${content}"`);
            } else {
                goAFK(client, seconds);
                logger.info(`Sleeping for ${seconds} seconds.`);
            }
        }
        else if (tokenHandlers[type]) {
            try {
                let raw = await tokenHandlers[type](content);
                if (typeof raw === "string") {
                    try { raw = JSON.parse(raw) } catch { }
                }
                results[type] = raw;
            } catch (e) {
                results[type] = `Error handling ${type}: ${e.message}`;
            }
        }
        // otherwise ignore unknown tokens
    }

    // Format results into context messages
    const contextMessages = [];
    for (const [key, data] of Object.entries(results)) {
        const header = key[0].toUpperCase() + key.slice(1);
        const body = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
        contextMessages.push({
            role: 'assistant',
            content: `${header}:\n${body}`
        });
    }
    return contextMessages;
}

/**
 * Perform a web search via Google Custom Search and return top 3 results.
 *
 * @param {string} query
 * @returns {Promise<string>}
 */
async function handleWebSearch(query) {
    const apiKey = process.env.GOOGLE_API_KEY;
    const cseId = process.env.GOOGLE_CSE_ID;
    const RETURN_RESULTS = 3;
    if (!apiKey || !cseId) {
        throw new Error("Missing GOOGLE_API_KEY or GOOGLE_CSE_ID in environment");
    }

    const params = new URLSearchParams({
        key: apiKey,
        cx: cseId,
        q: query,
        num: `${RETURN_RESULTS}` // ask Google for X results
    });

    const url = `https://www.googleapis.com/customsearch/v1?${params}`;
    try {
        const res = await fetch(url, { timeout: 5000 });
        if (!res.ok) {
            const text = await res.text();
            throw new Error(`HTTP ${res.status}: ${text}`);
        }
        const json = await res.json();
        if (json.error) {
            throw new Error(json.error.message);
        }

        const items = json.items || [];
        if (items.length === 0) {
            return `No results found for "${query}".`;
        } else {
            /*
            logger.info("Search results:");
            logger.info(`------------------------------------------------------------`);
            logger.info(JSON.stringify(items))
            logger.info(`------------------------------------------------------------`);
            */
        }

        // Format search results concisely
        const formattedResults = items.slice(0, RETURN_RESULTS).map(item => ({
            // Truncate title and snippet to save tokens
            title: item.title ? item.title.substring(0, 100) : 'No title',
            // Remove line breaks and extra spaces from snippet
            snippet: item.snippet 
                ? item.snippet.replace(/\s+/g, ' ').substring(0, 150) + '...' 
                : 'No description',
            // Just use the domain for the link to save space
            domain: item.link ? new URL(item.link).hostname.replace('www.', '') : 'no-link',
            link: item.link || ''
        }));

        // Log search results in a readable format
        const logOutput = [
            `\n=== Search Results for "${query}" ===`,
            `Found ${formattedResults.length} results:`,
            ...formattedResults.map((result, idx) => 
                `\n[${idx + 1}] ${result.title}\n   ${result.snippet}\n   ${result.domain} | ${result.link}`
            ),
            '\n=== End of Search Results ===\n'
        ].join('\n');
        
        logger.info(logOutput);
        
        // Return the formatted results
        return {
            query,
            results: formattedResults
        };

    } catch (err) {
        console.warn(`[handleWebSearch] error for "${query}":`, err.message);
        return `Error performing web search for "${query}": ${err.message}`;
    }
}

/**
 * Checks if a response is good enough, and if not, returns a better prompt
 * @param {Object} options
 * @param {Object} options.openai - OpenAI instance
 * @param {string} options.model - Model to use for checking
 * @param {Array} options.promptMessages - Current prompt messages
 * @param {string} options.candidate - Candidate response to check
 * @param {number} options.attempt - Current attempt number
 * @param {Array} options.feedbackHistory - History of previous feedback
 * @returns {Promise<string>} Either "[GOOD]" or a new prompt for improvement
 */
async function refinePrompt({ 
    openai, 
    model, 
    promptMessages, 
    candidate, 
    attempt = 1, 
    feedbackHistory = [],
    previousCandidates = []
}) {
    // Get the last user message for context
    const lastUserMessage = [...promptMessages].reverse().find(m => m.role === 'user')?.content || '';
    
    // Skip refinement for certain contexts
    if (!candidate || !promptMessages || promptMessages.length === 0) {
        logger.warn('Invalid input for refinement');
        return '[GOOD]';
    }
    
    // Build the refinement prompt
    const prompt = [
        {
            role: 'system',
            content: `You are a response quality analyst. Your task is to evaluate the assistant's response and provide specific, actionable feedback for improvement.
            
            If the response is perfect, return exactly: [GOOD]
            
            Otherwise, analyze the response and provide:
            1. A score from 1-10 for overall quality
            2. 1-3 specific suggestions for improvement
            3. A revised version of the response that addresses the issues
            
            Focus on:
            - Engagement and relevance to: "${lastUserMessage.slice(0, 100)}..."
            - Emotional expressiveness and character consistency
            - Structure and clarity of the response
            
            Important considerations:
            - Be specific about what needs to change and why
            - Provide concrete examples of improvements
            - Consider previous feedback: ${feedbackHistory.length ? feedbackHistory.join(' | ') : 'No previous feedback'}
            - Avoid making the same suggestions that didn't work before`
        },
        {
            role: 'user',
            content: `EVALUATE THIS RESPONSE:
            
            ===== ORIGINAL REQUEST =====
            ${lastUserMessage}
            
            ===== CURRENT CANDIDATE (ATTEMPT ${attempt}) =====
            ${candidate}
            
            ${previousCandidates.length > 0 ? `
            ===== PREVIOUS ATTEMPTS =====
            ${previousCandidates.map((cand, i) => `
            --- ATTEMPT ${i + 1} ---
            ${cand.candidate}
            
            FEEDBACK: ${cand.feedback}
            `).join('\n')}
            ` : ''}
            
            ${feedbackHistory.length ? `
            ===== FEEDBACK HISTORY =====
            ${feedbackHistory.map((f, i) => `ROUND ${i + 1}: ${f}`).join('\n\n')}
            ` : ''}
            
            ===== YOUR EVALUATION =====
            SCORE (1-10): 
            
            SUGGESTED IMPROVEMENTS:
            1. 
            2. 
            3. 
            
            REVISED VERSION:`
        }
    ];

    try {
        const resp = await openai.chat.completions.create({
            model,
            messages: prompt,
            temperature: 0.0,
            max_tokens: 400
        });

        const result = resp.choices[0]?.message?.content?.trim();
        logger.info(`Refinement result (attempt ${attempt}): ${result}`);
        
        if (!result) {
            logger.warn('Empty response from refinement model');
            return `The previous response was empty or incomplete. Please provide a complete response to: ${lastUserMessage}`;
        }
        
        // Only pass if explicitly marked as good
        if (result.toUpperCase().includes('[GOOD]')) {
            logger.info(`✅ Response passed quality check on attempt ${attempt}`);
            return '[GOOD]';
        }
        
        // Add the latest feedback to history (truncate if too long)
        const feedbackSummary = result.split('\n')[0].substring(0, 100);
        feedbackHistory.push(feedbackSummary);
        if (feedbackHistory.length > 3) {
            feedbackHistory.shift(); // Keep only the 3 most recent feedback items
        }
        
        // Return the refinement instructions
        return result;
    } catch (e) {
        logger.error('[refinePrompt] Error:', e);
        // Default to rewording if there's an error
        return `Rephrase the following in your own words while keeping the same meaning and tone:\n\n${candidate}`;
    }
}

// --- Chess Context Generator ---
const createGameManager = require('./chess/gameManager');
const { Chess } = require('chess.js');

// Get the game manager instance if it exists, but don't initialize it here
const gameManager = createGameManager.getInstanceIfExists();

/**
 * Generates a detailed context about the current chess game for a given playerId.
 * @param {string} playerId - The Discord user ID of the player
 * @returns {string|null} Detailed game context or null if no game exists
 */
function generateChessContext(playerId) {
    if (!gameManager) {
        logger.debug('[Chess Context] Game manager not initialized');
        return null;
    }
    
    const gameData = gameManager.getGameData(playerId);
    if (!gameData || !gameData.gameInstance) {
        logger.debug(`[Chess Context] No active game found for user ${playerId}`);
        return null;
    }

    try {
        const game = gameData.gameInstance;
        const fen = game.fen();
        const isPlayerTurn = game.turn() === gameData.playerColor[0];
        const playerColor = gameData.playerColor === 'w' ? 'White' : 'Black';
        const opponentColor = playerColor === 'White' ? 'Black' : 'White';
        const moveNumber = Math.ceil(game.history().length / 2);
        
        // Determine if the bot is a player in this game
        const isBotGame = gameManager.client && 
                        (playerId === gameManager.client.user.id || 
                         gameData.opponent === gameManager.client.user.id);
        const botColor = isBotGame ? 
            (playerId === gameManager.client.user.id ? playerColor : opponentColor) : 
            null;
        
        // Game status
        const isCheck = game.inCheck();
        const isCheckmate = game.isCheckmate();
        const isDraw = game.isDraw();
        const isGameOver = game.isGameOver();
        
        // Material balance
        const material = getMaterialBalance(game);
        
        // Position evaluation (simplified)
        const positionEval = evaluatePosition(game, material);
        
        // Generate context
        let context = `## Chess Game Context\n`;
        
        // Player information
        if (isBotGame) {
            context += `- **You are playing against RolyBot**\n`;
            context += `- **Your color**: ${playerColor}\n`;
            context += `- **RolyBot's color**: ${botColor}\n`;
        } else {
            context += `- **Player**: ${playerColor} (${isPlayerTurn ? 'Your turn' : 'Opponent\'s turn'})\n`;
        }
        
        // Game state
        context += `- **Move**: ${moveNumber}${game.turn() === 'w' ? '. ' : '... '}`;
        if (isBotGame) {
            context += game.turn() === (botColor[0].toLowerCase() === 'w' ? 'w' : 'b') ? 
                'RolyBot is thinking...' : 'Your move';
        } else {
            context += isPlayerTurn ? 'Your move' : 'Waiting for opponent';
        }
        context += '\n';
        
        // Game status
        if (isGameOver) {
            if (isCheckmate) {
                if (isBotGame) {
                    const winner = game.turn() === (botColor[0].toLowerCase() === 'w' ? 'w' : 'b') ? 
                        'You won by checkmate!' : 'RolyBot won by checkmate';
                    context += `- **Status**: ${winner}\n`;
                } else {
                    context += `- **Status**: ${isPlayerTurn ? 'You lost by checkmate' : 'You won by checkmate!'}\n`;
                }
            } else if (isDraw) {
                context += `- **Status**: Game drawn by ${getDrawReason(game)}\n`;
            } else {
                context += `- **Status**: Game over\n`;
            }
        } else {
            context += `- **Check**: ${isCheck ? 'Yes' : 'No'}\n`;
        }
        
        // Position evaluation
        context += `- **Material**: ${material}\n`;
        context += `- **Position**: ${positionEval}\n`;
        
        // Recent moves (last 3 moves)
        const recentMoves = game.history({ verbose: true }).slice(-3);
        if (recentMoves.length > 0) {
            context += `\n**Recent Moves**:\n`;
            recentMoves.forEach((move, i) => {
                const moveNumber = Math.ceil((game.history().length - recentMoves.length + i + 1) / 2);
                const movePrefix = move.color === 'w' ? `${moveNumber}.` : `${moveNumber}...`;
                context += `- ${movePrefix} ${move.san}${move.captured ? 'x' : ''}${move.promotion ? `=${move.promotion.toUpperCase()}` : ''}\n`;
            });
        }
        
        // Possible moves (if it's the player's turn and game isn't over)
        if (isPlayerTurn && !isGameOver) {
            const moves = game.moves({ verbose: true });
            const captureMoves = moves.filter(m => m.captured);
            const checkMoves = moves.filter(m => m.san.includes('+'));
            
            if (moves.length > 0) {
                context += `\n**Possible Moves**: ${moves.length} total`;
                if (captureMoves.length > 0) context += `, ${captureMoves.length} captures`;
                if (checkMoves.length > 0) context += `, ${checkMoves.length} checks`;
                context += '\n';
                
                // Show sample of possible moves (up to 5)
                const sampleMoves = moves.slice(0, 5).map(m => m.san).join(', ');
                if (sampleMoves) {
                    context += `Sample: ${sampleMoves}${moves.length > 5 ? '...' : ''}\n`;
                }
            }
        }
        
        logger.debug(`[Chess Context] Generated context for user ${playerId}`);
        return context;
        
    } catch (error) {
        logger.error(`[Chess Context] Error generating context: ${error.message}`, error);
        return null;
    }
}

/**
 * Evaluates the current board position
 * @param {Chess} game - The chess.js game instance
 * @param {string} material - Material balance string
 * @returns {string} Position evaluation
 */
function evaluatePosition(game, material) {
    if (game.isCheckmate()) {
        return game.turn() === 'w' ? 'Black has checkmated White' : 'White has checkmated Black';
    }
    
    if (game.isDraw()) {
        return 'Position is drawn';
    }
    
    const materialDiff = material.includes('up') ? material : 'Material is equal';
    const pieceCount = game.board().flat().filter(sq => sq).length;
    const phase = pieceCount > 24 ? 'Opening' : pieceCount > 16 ? 'Middlegame' : 'Endgame';
    
    let evaluation = `${phase} position, ${materialDiff}. `;
    
    if (game.inCheck()) {
        evaluation += 'King is in check. ';
    }
    
    // Count pieces for both sides
    const pieces = { w: { p: 0, n: 0, b: 0, r: 0, q: 0 }, b: { p: 0, n: 0, b: 0, r: 0, q: 0 } };
    for (const row of game.board()) {
        for (const piece of row) {
            if (piece) {
                pieces[piece.color][piece.type]++;
            }
        }
    }
    
    // Add piece count to evaluation
    const addPieceCount = (color) => {
        const p = pieces[color];
        return `${color === 'w' ? 'White' : 'Black'}: ${p.p > 0 ? p.p + 'P ' : ''}${p.n > 0 ? p.n + 'N ' : ''}${p.b > 0 ? p.b + 'B ' : ''}${p.r > 0 ? p.r + 'R ' : ''}${p.q > 0 ? p.q + 'Q ' : ''}`.trim();
    };
    
    evaluation += `White: ${addPieceCount('w')} | Black: ${addPieceCount('b')}`;
    
    return evaluation;
}

/**
 * Gets the reason for a draw
 * @param {Chess} game - The chess.js game instance
 * @returns {string} The draw reason
 */
function getDrawReason(game) {
    if (game.isStalemate()) return 'stalemate';
    if (game.isThreefoldRepetition()) return 'threefold repetition';
    if (game.isInsufficientMaterial()) return 'insufficient material';
    if (game.isDraw()) return 'fifty-move rule';
    return 'unknown reason';
}

/**
 * Calculates material balance on the board
 * @param {Chess} game - The chess.js game instance
 * @returns {string} Material balance description
 */
function getMaterialBalance(game) {
    const pieceValues = { p: 1, n: 3, b: 3, r: 5, q: 9 };
    let white = 0, black = 0;
    
    for (const row of game.board()) {
        for (const piece of row) {
            if (!piece) continue;
            const value = pieceValues[piece.type] || 0;
            if (piece.color === 'w') white += value;
            else black += value;
        }
    }
    
    const diff = Math.abs(white - black);
    if (diff === 0) return 'Material is even';
    
    const leadingColor = white > black ? 'White' : 'Black';
    const pieceDiff = diff === 1 ? 'a pawn' : 
                      diff <= 3 ? 'a minor piece' : 
                      diff <= 5 ? 'a rook' : 
                      diff < 9 ? 'a queen' : 
                      'significant material';
    
    return `${leadingColor} is up ${pieceDiff} (${diff} points)`;
}

module.exports = {
    generateSystemMessage,
    generateSimilarMessagesSummary,
    generateTokenSelectorPrompt,
    generateChessContext,
    generateRecentMessagesContext,
    buildGenMessages,
    injectContextFunctionTokens,
    refinePrompt
};
