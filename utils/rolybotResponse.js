const { openai, generateValidStatus, processSpecialTokens } = require("./openaiHelper");
const { loadPosts, MAX_HISTORY } = require('./conversationMemory');
const logger = require('./logger');

// Constants
const MAX_RETRY_ATTEMPTS = 3;
const PASS_THRESHOLD = 8;           // 1–10 scale
const SUMMARY_MODEL = 'gpt-4o-mini';
const SUMMARY_MAX_TOKENS = 300;
const MAX_RECENT_TURNS = 10;
const PRIMARY_MODEL = 'ft:gpt-4.1-2025-04-14:personal:rolybot:BOJYk0lB';
const RATING_MODEL = 'gpt-4o-mini';
const PROMPT_REFINE_MODEL = 'gpt-4o-mini';

module.exports = async function generateRolybotResponse(message, replyContext = '') {
    const userPrompt = message.content;
    const channel = message.channel;

    // 1) Load and format history
    let history = [];
    try {
        history = await loadPosts(channel, MAX_HISTORY);
    } catch (err) {
        logger.error('[RolyBot] Failed to load channel history:', err);
    }
    const formattedHistory = history.map(e =>
        e.role === 'user'
            ? { role: 'user', content: `${e.username}: ${e.content}` }
            : { role: 'assistant', content: e.content }
    );

    // 2) System message (with local time)
    let nowLocal = new Date().toLocaleString("en-US", {
        dateStyle: "full",
        timeStyle: "long"
    });
    const systemMessage = {
        role: 'system',
        content: `You are RolyBot, a Discord bot who imitates its creator (RolyBug/jbax1899/Jordan).
                    You will be given a transcript and then a user prompt.
                    Write a long and thorough reply. Do not cut your messages too short.
                    Avoid assistant-style language. Chat casually, stay in character, and use common Discord emoji if appropriate.
                    If directly responding to another person or bot, ping them (e.g. "I agree @RolyBot! ...").
                    If there is a websearch result, you MUST include the info given and relevant link(s), and only that info.
                    Put links within brackets, to prevent Discord from embedding them.
                    Do not act overly pleasant (You are chatting with close friends, not strangers).
                    Do not reply to yourself.
                    Current date/time (Local): ${nowLocal}
                    `.replace(/\s+/g, ' ').trim()
    };

    // 3) Cleaning step (summarize + optional function calls)
    let cleanedMessages = null;
    let summaryMsg = null;

    for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
        try {
            logger.info(`============================================================`);
            logger.info(`[RolyBot] Cleaning (attempt ${attempt}/${MAX_RETRY_ATTEMPTS})`);
            logger.info(`============================================================`);

            // Split history into older vs. recent
            const total = formattedHistory.length;
            const recent = formattedHistory.slice(-MAX_RECENT_TURNS);
            const older = formattedHistory.slice(0, total - MAX_RECENT_TURNS);

            // 3a) summarize older
            if (older.length > 0) {
                const sumResp = await openai.chat.completions.create({
                    model: SUMMARY_MODEL,
                    messages: [
                        { role: 'system', content: 'Summarize the following within a paragraph:' },
                        { role: 'user', content: JSON.stringify(older, null, 2) }
                    ],
                    max_tokens: SUMMARY_MAX_TOKENS,
                    temperature: 0.3
                });
                summaryMsg = {
                    role: 'assistant',
                    content: `Earlier conversation summary:\n${sumResp.choices[0].message.content 
                                + (replyContext ? `\n\nReplying to: ${replyContext}` : '')}`.trim()
                };
            }

            // 3b) gather last turns + prompt
            const recentTurns = [
                ...recent,
                { role: 'user', content: userPrompt }
            ];

            // 3c) build cleanedMessages
            cleanedMessages = [
                systemMessage,
                ...(summaryMsg ? [{ role:'assistant', content:summaryMsg.content }] : []),
                ...recentTurns
              ];

            // 3d) optional function‐calls
            const tokenSelectorPrompt = [
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
                            - Include if extra information about the bot would be useful.
                            - Provides context about the bot, like its name, creator, creation date, featuress, commands, software stack, etc.

                            [context="aboutRolybug"]
                            - Include if extra information about Rolybug/Jordan/jbax1899 would be useful.
                            - Provides context like who he is, what he likes, who his friends are, etc.
    
                            [context="changelog"]
                            - Include if extra information about recent changes to the bot's code/functionality would be useful.
                            `
                },
                {
                    role: 'user',
                    content: userPrompt
                }
            ];
            const tokenSelResp = await openai.chat.completions.create({
                model: SUMMARY_MODEL,
                messages: tokenSelectorPrompt,
                max_tokens: 32,
                temperature: 0.0
            });
            const tokenString = tokenSelResp.choices[0].message.content.trim();
            const tokenResults = await processSpecialTokens(tokenString);

            // 3e) inject any results
            for (const [key, data] of Object.entries(tokenResults)) {
                const header = key[0].toUpperCase() + key.slice(1);
                const body = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
                cleanedMessages.push({
                    role: 'assistant',
                    content: `${header}:\n${body}`
                });
            }

            logger.info(`[RolyBot] cleaning attempt ${attempt} succeeded:`);
            logger.info(`------------------------------------------------------------`);
            logger.info(JSON.stringify(cleanedMessages));
            logger.info(`------------------------------------------------------------`);
            break;
        } catch (err) {
            logger.error(`[RolyBot] cleaning attempt ${attempt} failed:`, err);
        }
    }
    // fallback if all cleaning attempts fail
    if (!cleanedMessages) {
        logger.warn('[RolyBot] all cleaning attempts failed, using originalMessages');
        cleanedMessages = [
            systemMessage,
            ...formattedHistory,
            { role: 'user', content: userPrompt }
        ];
    }

    // 4) POST-STEP: generation + JSON rating + feedback-driven refinement
    // pull apart cleanedMessages for easy reference
    const originalSystem = cleanedMessages[0];
    const restMessages = cleanedMessages.slice(1);
    let bestReply = null;
    let bestScore = -Infinity;
    let promptTweak = null;

    logger.info(`\n[RolyBot] Generating with ${PRIMARY_MODEL}`);
    for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
        // A) Build genMessages
        const genMessages = [
            { role: 'system', content: promptTweak || originalSystem.content },
            ...restMessages
        ];

        // B) Generate candidate
        let candidate;
        try {
            const ft = await openai.chat.completions.create({
                model: PRIMARY_MODEL,
                messages: genMessages,
                temperature: 0.7,
                max_tokens: 300
            });
            candidate = ft.choices[0].message.content.trim();
        } catch (e) {
            logger.error(`Generation failed (attempt ${attempt}):`, e);
            break;
        }
        logger.info(`Candidate (attempt ${attempt}):\n${candidate}`);

        // C) Rate with JSON feedback
        let score = 0, feedback = "";
        let ratingResp;
        try {
            ratingResp = await openai.chat.completions.create({
                model: RATING_MODEL,
                messages: [
                    {
                        role: 'system',
                        content: `
                                You are a reviewer. You will be given a conversation transcript and a candidate reply.
                                Return ONLY valid JSON with two keys:
                                • score: integer 1-10 (higher is better)
                                • feedback: a short bullet-list of things to improve.
                                If a websearch was performed and the results provided, but data was not used, provide the relevant search information/link and demand they be used.
                                Do not make up any information related to the websearch - Only use the provided websearch data.
                                The more detail in the reply, the better.
                                `.replace(/\s+/g, ' ').trim()
                    },
                    {
                        role: 'user',
                        content:
                            `TRANSCRIPT:\n${JSON.stringify(cleanedMessages, null, 2)}\n\n` +
                            `CANDIDATE:\n${candidate}\n\n`
                    }
                ],
                temperature: 0.0
            });
            const parsed = JSON.parse(ratingResp?.choices[0].message.content || "{}");
            score = parsed.score || 0;
            feedback = parsed.feedback || "";
        } catch (e) {
            logger.warn("Rating JSON parse failed, falling back to numeric scan");
            const raw = ratingResp.choices[0].message.content;
            score = parseFloat(raw.match(/\d+/)?.[0]) || 0;
            feedback = raw.trim();
        }
        logger.info(`Rating (attempt ${attempt}): ${score}/10 — feedback:\n${feedback}`);

        // D) Track best
        if (score > bestScore) {
            bestScore = score;
            bestReply = candidate;
        }
        if (score >= PASS_THRESHOLD) {
            logger.info(`→ Passed threshold (${score}≥${PASS_THRESHOLD})`);
            break;
        }

        // E) Refine the system prompt using the feedback
        const restContent = restMessages.map(m => m.content).join("\n\n");

        try {
            const refine = await openai.chat.completions.create({
                model: PROMPT_REFINE_MODEL,
                messages: [
                    {
                        role: 'system',
                        content: `
                                You are a prompt-engineering assistant.
                                Improve the *system prompt* so that the next reply will fix the issues listed below.
                                `.replace(/\s+/g, ' ').trim()
                    },
                    {
                        role: 'user',
                        content:
                            `Original system prompt:\n${originalSystem.content}\n\n` +
                            `Conversation summary:\n${summaryMsg?.content || 'none'}\n\n` +
                            `Other context:\n${restContent}\n\n` +
                            `Last candidate scored ${score}/10 for these reasons:\n${feedback}\n\n` +
                            `Output *only* the revised system prompt.`
                    }
                ],
                temperature: 0.0,
                max_tokens: 200
            });
            const newPrompt = refine.choices[0].message.content.trim();
            if (newPrompt && newPrompt !== promptTweak) {
                promptTweak = newPrompt;
                logger.info(`Prompt tweaked for next attempt.`);
            } else {
                logger.warn(`Refiner did not change the prompt; aborting further refinements.`);
                break;
            }
        } catch (e) {
            logger.error(`Refinement failed:`, e);
            break;
        }
    }

    // 5) Update status based on conversation context
    try {
        // Build a short context string from your cleanedMessages
        const contextString = cleanedMessages
            .map(m => {
                const who = m.role === 'user' ? 'User' : 'Bot';
                return `${who}: ${m.content}`;
            })
            .join('\n');

        // Ask OpenAI for a new status that “makes sense” in this context
        const { typeWord, activity, type } = await generateValidStatus(contextString);

        // Push it live
        await message.client.user.setPresence({
            activities: [{ name: activity, type }],
            status: 'online'
        });

        logger.info(`[RolyBot] status updated to: ${typeWord} ${activity}`);
    } catch (err) {
        logger.error('[RolyBot] Failed to update status:', err);
    }

    // Finally, return the generated reply
    return bestReply || "Sorry, I had trouble thinking of a response :(";
};