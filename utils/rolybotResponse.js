const { openai } = require('./openaiHelper');
const { generateValidStatus, processSpecialTokens } = require("./openaiHelper");
const { loadPosts, MAX_HISTORY } = require('./conversationMemory');
const logger = require('./logger');

// Constants
const MAX_RETRY_ATTEMPTS = 3;
const PASS_THRESHOLD = 8;  // 1–10 scale
// Cleaning step
const EMBEDDING_MODEL = 'text-embedding-ada-002';
const SUMMARIZATION_MODEL = 'gpt-4o-mini';
const TOP_K = 10; // max number of messages to keep
const K_MIN = 0.7; // minimum cosine‐similarity to qualify
const SUMMARY_MAX_TOKENS = 300;
// Primary model
const PRIMARY_MODEL = 'ft:gpt-4.1-2025-04-14:personal:rolybot:BOJYk0lB';
// Rating step
const RATING_MODEL = 'gpt-4o-mini';
const PROMPT_REFINE_MODEL = 'gpt-4o-mini';

module.exports = async function generateRolybotResponse(message) {
    const userPrompt = message.content;
    const channel = message.channel;

    // 1) Load history
    let history = [];
    try {
        history = await loadPosts(channel, MAX_HISTORY);
    } catch (err) {
        logger.error('[RolyBot] Failed to load channel history:', err);
    }

    // 2) Format history
    const formattedHistory = history.map(e =>
        e.role === 'user'
            ? { role: 'user', content: `${e.username}: ${e.content}` }
            : { role: 'assistant', content: e.content }
    );

    // 3) Build extraContext
    let nowLocal = new Date().toLocaleString("en-US", {
        dateStyle: "full", // e.g. "Thursday, April 24, 2025"
        timeStyle: "long" // e.g. "9:13:45 PM EDT"
    });
    const extraContext = `\nCurrent date/time (Local): ${nowLocal}`;
    /*
    try {
        const [aliasesRaw, usersRaw] = await Promise.all([
            fs.readFile('./aliases.json', 'utf-8'),
            fs.readFile('./users_cleaned.json', 'utf-8')
        ]);
        const aliases = JSON.parse(aliasesRaw);
        const users = JSON.parse(usersRaw);
        const words = lowerPrompt.split(/\W+/);
        const matched = new Set();
        words.forEach(w => {
            for (let k in aliases) {
                if (aliases[k].includes(w)) { matched.add(k); break; }
            }
        });
        for (let username of matched) {
            const u = users.find(x => x.username === username);
            if (!u) continue;
            const p = u.personality
                .split('\n').map(l => l.trim()).filter(l => l).join(' ');
            extraContext += `\nAbout ${username}: ${p}\n`;
        }
    } catch (err) {
        logger.error('[RolyBot] Error building extraContext:', err);
    }
    */

    // 4) Build the un‑cleaned payload
    const systemMessage = {
        role: 'system',
        content: `You are RolyBot, a Discord bot who imitates the user RolyBug (aka jbax1899 or Jordan).
                    You will be given a transcript and then a user prompt.
                    Write a long and thorough reply. Do not cut your messages too short.
                    Avoid assistant-style language. Chat casually, stay in character, and use common Discord emoji if appropriate.
                    If interacting with other people/bots, ping them (e.g. "I agree @RolyBot! ...").
                    If there is a websearch result, you MUST include the info given and relevant link(s), and only that info.
                    Do not act overly pleasant (You are chatting with close friends, not strangers).
                    ${extraContext}`
            .replace(/\s+/g, ' ').trim()
    };

    const originalMessages = [
        systemMessage,
        ...formattedHistory
    ];

    logger.info('\n[RolyBot] original payload:\n' + JSON.stringify(originalMessages) + "\n");

    // 5) PRE-STEP, CLEANING: clean/reorder the entire message array, with retries
    let cleanedMessages = null;
    for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
        try {
            logger.info(`============================================================`);
            logger.info(`[RolyBot] Cleaning (attempt ${attempt}/${MAX_RETRY_ATTEMPTS})`);
            logger.info(`============================================================`);

            // a) embed the new user prompt
            const [{ embedding: promptVec }] = (await openai.embeddings.create({
                model: EMBEDDING_MODEL,
                input: userPrompt
            })).data;

            // b) embed each history message (in parallel)
            const embedCalls = formattedHistory.map(m =>
                openai.embeddings.create({ model: EMBEDDING_MODEL, input: m.content })
            );
            const embedResults = await Promise.all(embedCalls);

            // c) cosine‐score each message vs. prompt
            const sims = embedResults.map((res, i) => {
                const vec = res.data[0].embedding;
                const dot = vec.reduce((sum, v, j) => sum + v * promptVec[j], 0);
                const magA = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
                const magB = Math.sqrt(promptVec.reduce((s, v) => s + v * v, 0));
                return { msg: formattedHistory[i], score: dot / (magA * magB) };
            });

            logger.info(`[RolyBot] Similarities:`);
            logger.info(`------------------------------------------------------------`);
            logger.info(sims
                .map(s => `${s.msg.content.slice(0, 50)}… → ${s.score.toFixed(3)}`)
                .join('\n')
            );
            logger.info(`------------------------------------------------------------`);

            // 1) Filter out anything below the threshold
            const aboveThreshold = sims.filter(s => s.score >= K_MIN);

            // 2) Sort the survivors by descending score
            aboveThreshold.sort((a, b) => b.score - a.score);

            // 3) Take up to TOP_K of them
            let topMessages = aboveThreshold
                .slice(0, TOP_K)
                .map(x => x.msg);

            // 4) Fallback: if nothing passed the threshold, at least grab the very top one
            if (topMessages.length === 0 && sims.length > 0) {
                topMessages = [sims.sort((a, b) => b.score - a.score)[0].msg];
            }

            logger.info(`[RolyBot] Selected top ${TOP_K} messages:`);
            logger.info(`------------------------------------------------------------`);
            logger.info(topMessages.map(m => `- ${m.content.slice(0, 80)}`).join('\n'));
            logger.info(`------------------------------------------------------------`);

            // e1) TOKEN SELECTOR: decide which function‐calls to make
            const tokenSelectorPrompt = [
                {
                    role: 'system',
                    content: `You are tasked with pre-processing a chatlog before it is fed into the main LLM call.
                            If any of the below functions make sense to use, add them to your output.
    
                            Available functions:
    
                            [websearch="search query here"]
                            - Only ONE websearch is allowed at most. Do not include more than one websearch function.
                            - Only apply to the prompt (${formattedHistory[0]})
                            - Include if the prompt asked you to do a web search, for recent news on something, or if extra information may be useful for you to answer (like real-time/current information).
                            - If looking for recent info, do not include a time period.
                            - Example: [websearch="apple stock value"]

                            [context="aboutBot"]
                            - Include if extra information about the bot would be useful.
                            - Provides context like who made the bot, what language the bot was coded in, when the bot was made, etc.

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
                model: SUMMARIZATION_MODEL,
                messages: tokenSelectorPrompt,
                max_tokens: 32,
                temperature: 0.0
            });

            const tokenString = tokenSelResp.choices[0].message.content.trim();
            logger.info("Selected tokens: " + tokenString)

            // e2) RUN your tokens through your handlers
            const tokenResults = await processSpecialTokens(tokenString);

            // e3) SUMMARIZER: now produce a plain text summary
            const summarizerPrompt = [
                {
                    role: 'system',
                    content: `
                            You are a summarizer for a Discord chat assistant.
                            Summarize the following messages in one or two concise paragraphs.
                            `.replace(/\s+/g, ' ').trim()
                },
                {
                    role: 'user',
                    content: JSON.stringify(topMessages, null, 2)
                }
            ];

            const sumResp2 = await openai.chat.completions.create({
                model: SUMMARIZATION_MODEL,
                messages: summarizerPrompt,
                max_tokens: SUMMARY_MAX_TOKENS,
                temperature: 0.3
            });
            const summaryClean = sumResp2.choices[0].message.content.replace(/\[\w+="[^"]*"\]/g, '').trim(); // Remove tokens from summary for display

            // e4) BUILD cleanedMessages
            cleanedMessages = [systemMessage];

            // inject each token result (e.g. websearch results)
            for (const [key, data] of Object.entries(tokenResults)) {
                const header = key[0].toUpperCase() + key.slice(1);
                const body = typeof data === "string"
                    ? data
                    : JSON.stringify(data, null, 2);
                cleanedMessages.push({
                    role: 'system',
                    content: `${header}:\n${body}`
                });
                //logger.info(`${header}:\n${body}`)
            }

            // inject the plain conversation summary
            cleanedMessages.push({
                role: 'system',
                content: `Conversation summary:\n${summaryClean}`
            });

            // finally the user’s original prompt
            cleanedMessages.push({
                role: 'user',
                content: userPrompt
            });

            // Add conversation 
            cleanedMessages.push({ role: 'system', content: `Conversation summary:\n${summaryClean}` })

            // Add user prompt
            cleanedMessages.push({ role: 'user', content: userPrompt });

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
        cleanedMessages = originalMessages;
    }

    // 6) POST-STEP: generation + JSON rating + feedback-driven refinement
    // pull apart cleanedMessages for easy reference
    const [originalSystem, summaryMsg, ...afterSummary] = cleanedMessages;
    let bestReply = null;
    let bestScore = -Infinity;
    let promptTweak = null;

    logger.info(`\n[RolyBot] Generating with ${PRIMARY_MODEL}`);
    for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
        // A) Build genMessages
        const genMessages = [
            { role: 'system', content: promptTweak || originalSystem.content },
            summaryMsg,
            ...afterSummary
        ];

        // B) Generate candidate
        let candidate;
        try {
            const ft = await openai.chat.completions.create({
                model: PRIMARY_MODEL,
                messages: genMessages,
                temperature: 0.8,
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
        try {
            const ratingResp = await openai.chat.completions.create({
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
            const parsed = JSON.parse(ratingResp.choices[0].message.content);
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
        const restContent = afterSummary.map(m => m.content).join("\n\n");

        /*
        logger.warn(`Original system prompt:\n${originalSystem.content}\n\n` +
                    `Conversation summary:\n${summaryMsg.content}\n\n` +
                    `Other context:\n${restContent}\n\n` +
                    `Last candidate scored ${score}/10 for these reasons:\n${feedback}\n\n` +
                    `Please output *only* the revised system prompt.`)
        */

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
                            `Conversation summary:\n${summaryMsg.content}\n\n` +
                            `Other context:\n${restContent}\n\n` +
                            `Last candidate scored ${score}/10 for these reasons:\n${feedback}\n\n` +
                            `Please output *only* the revised system prompt.`
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

    // 7) Update status based on conversation context
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