const { performance } = require('perf_hooks');
const { openai } = require('./openaiHelper');
const { generateValidStatus } = require("./openaiHelper");
const { loadPosts, MAX_HISTORY } = require('./conversationMemory');
const logger = require('./logger');

// Constants
const MAX_RETRY_ATTEMPTS = 3;
const PASS_THRESHOLD = 7;  // 1–10 scale
// Cleaning step
const EMBEDDING_MODEL = 'text-embedding-ada-002';
const SUMMARIZATION_MODEL = 'gpt-4o-mini';
const TOP_K = 10;
const SUMMARY_MAX_TOKENS = 100;
// Primary model
const PRIMARY_MODEL = 'ft:gpt-4.1-2025-04-14:personal:rolybot:BOJYk0lB';
// Rating step
const RATING_MODEL = 'gpt-4o-mini';

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
    let extraContext = '';
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

    // 4) Build the un‑cleaned payload (including the user prompt!)
    const systemMessage = {
        role: 'system',
        content: `You are RolyBot, a Discord bot who imitates the user RolyBug (aka jbax1899 or Jordan).
                    Chat casually, stay in character, and use Discord emoji where appropriate.
                    You will be given a transcript and then a user prompt.
                    Write a long reply, and do NOT use assistant-style language.
                    Interact with other bots by saying their respective activation keywords (flukebot, marco) where appropriate.
                    Always respond to evanski with sarcasm and spite.
                    Remove any message prefixes (e.g. "<word>: ").
                    ${extraContext}
                    Begin transcript:`
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

            // d) pick top K
            const topMessages = sims
                .sort((a, b) => b.score - a.score)
                .slice(0, TOP_K)
                .map(x => x.msg);

            logger.info(`[RolyBot] Selected top ${TOP_K} messages:`);
            logger.info(`------------------------------------------------------------`);
            logger.info(topMessages.map(m => `- ${m.content.slice(0, 80)}`).join('\n'));
            logger.info(`------------------------------------------------------------`);

            // e) summarize those top K into 2 sentences
            const sumPrompt = [
                {
                    role: 'system',
                    content: 'You are a helpful assistant that summarizes Discord chat.'
                },
                {
                    role: 'user',
                    content:
                        `Please summarize the following ${topMessages.length} messages in up to ${TOP_K} sentences, focusing only on the key points.\n\n` +
                        JSON.stringify(topMessages, null, 2)
                }
            ];
            const sumResp = await openai.chat.completions.create({
                model: SUMMARIZATION_MODEL,
                messages: sumPrompt,
                max_tokens: SUMMARY_MAX_TOKENS,
                temperature: 0.3
            });
            const summary = sumResp.choices[0].message.content.trim();
            logger.info(`[RolyBot] cleaning attempt ${attempt} summary:\n${summary}\n`);

            // f) build the cleanedMessages array:
            //    [ systemMessage, summary‐as‐system‐note, user prompt ]
            cleanedMessages = [
                systemMessage,
                { role: 'system', content: `Conversation summary:\n${summary}` },
                { role: 'user', content: userPrompt }
            ];

            logger.info(`[RolyBot] cleaning attempt ${attempt} succeeded`);
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

    // 6) POST‑STEP: retry loop + rating
    let bestReply = null;
    let bestScore = -Infinity;

    logger.info(`============================================================`);
    logger.info(`Generating response with the primary model (${PRIMARY_MODEL})`);
    logger.info(`============================================================`);

    for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
        try {
            // 6a) ask your finetuned model
            const t0 = performance.now();
            const ft = await openai.chat.completions.create({
                model: PRIMARY_MODEL,
                messages: cleanedMessages,
                temperature: 0.8,
                max_tokens: 300
            });
            const candidate = ft.choices[0].message.content.trim();
            const dt = (performance.now() - t0).toFixed(1);
            logger.info(`[RolyBot] attempt ${attempt}, recieved (${dt}ms):`);
            logger.info(`------------------------------------------------------------`);
            logger.info(`${candidate}`);
            logger.info(`------------------------------------------------------------`);

            // 6b) now rate that reply with o4-mini
            const ratePrompt = `You are a reviewer. Given a transcript and a candidate reply, ` +
                `rate it on a scale from 1 to 10 (tone, helpfulness, staying in character, and overall quality). ` +
                `Return ONLY the numeric score.\n\n` +
                `TRANSCRIPT:\n${JSON.stringify(cleanedMessages, null, 2)}\n\n` +
                `CANDIDATE:\n${candidate}\n\n` +
                `SCORE:`;

            const rateResp = await openai.responses.create({
                model: RATING_MODEL,
                input: ratePrompt
            });

            const score = parseFloat(rateResp.output_text.trim()) || 0;
            logger.info(`[RolyBot] rating attempt ${attempt} score: ${score}`);

            if (score > bestScore) {
                bestScore = score;
                bestReply = candidate;
            }
            if (score >= PASS_THRESHOLD) {
                logger.info("[RolyBot] Response passes judgement (minimum score of " + PASS_THRESHOLD + " required)");
                break;
            } else {
                logger.info("[RolyBot] Response fails judgement (minimum score of " + PASS_THRESHOLD + " required)");
            }
        } catch (err) {
            logger.error(`[RolyBot] rating attempt ${attempt} error:`, err);
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