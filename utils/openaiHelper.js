const OpenAI = require("openai");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const logger = require('./logger');

const typeMap = { Playing: 0, Streaming: 1, Listening: 2, Watching: 3 };
const typeNames = Object.keys(typeMap);

// Rate limiting
const MAX_REQUESTS = 3; // Max allowed in window
const WINDOW_SECONDS = 180; // Window duration (seconds)
const RATE_LIMIT_SECONDS = 10; // AFK duration (seconds) to default to if it is not provided
const MAX_AFK_DURATION = 300; // Max AFK duration (seconds)
let requestTimestamps = [];

async function generateValidStatus(context = "", maxAttempts = 3) {
    const STATUS_MODEL = "gpt-4o-mini";

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const typeWord = typeNames[Math.floor(Math.random() * typeNames.length)]; // Grab a random type

        const prompt = `
            You are a Discord bot who, based on the following conversation, invents one short, funny status in EXACTLY this format "<type> <activity>":

            === Conversation ===
            ${context}

            === Now produce 1 status ===
            • No quotes/markdown/links/hashtags/mentions
            • Must be a complete sentence <50 chars
            • Output format: ${typeWord} <activity>
            • Example: "${typeWord} to my music playlist"
            `.trim();

        const response = await openai.responses.create({
            model: STATUS_MODEL,
            input: prompt,
            temperature: 0.7
        });

        // 1) Grab the array of outputs
        const outputs = response.output || [];
        if (outputs.length === 0) {
            console.warn(`❌ no outputs (attempt ${attempt})`);
            continue;
        }

        // 2) Grab the first 'message' and its content segments
        const firstMsg = outputs[0];
        const segments = firstMsg.content || [];
        if (segments.length === 0) {
            console.warn(`❌ empty content (attempt ${attempt})`);
            continue;
        }

        // 3) Stitch all segments' text together
        const raw = segments.map(seg => seg.text).join("").trim()
            .replace(/^['"“”]+|['"“”]+$/g, "")
            .trim();

        if (raw.length > 50) {
            console.warn(`❌ too long (attempt ${attempt}): "${raw}"`);
            continue;
        }

        const [gotTypeWord, ...activityParts] = raw.split(" ");
        const activity = activityParts.join(" ");
        if (typeMap[gotTypeWord] === undefined || !activity) {
            console.warn(`❌ malformed (attempt ${attempt}): "${raw}"`);
            continue;
        }

        return {
            typeWord: gotTypeWord,
            activity,
            type: typeMap[gotTypeWord],
            rawStatus: raw,
            usage: response.usage || {}
        };
    }

    throw new Error(`Failed to generate a valid status after ${maxAttempts} attempts.`);
}

function recordRolybotRequest() {
    const now = Date.now();
    requestTimestamps.push(now);
    // Only keep requests in WINDOW_SECONDS seconds
    requestTimestamps = requestTimestamps.filter(
        ts => now - ts < WINDOW_SECONDS * 1000
    );
}

function tooManyRolybotRequests() {
    const now = Date.now();
    // Only count recent requests in WINDOW_SECONDS seconds
    const recent = requestTimestamps.filter(
        ts => now - ts < WINDOW_SECONDS * 1000
    );
    return recent.length > MAX_REQUESTS;
}

async function goAFK(client, duration = RATE_LIMIT_SECONDS, message, setAFK) {
    if (duration > MAX_AFK_DURATION) {
        duration = MAX_AFK_DURATION;
        logger.warn(`[RolyBot] AFK duration (${duration}s) limited to ${MAX_AFK_DURATION}s`);
    }

    logger.info(`[RolyBot] Going AFK for ${duration}s`);

    if (setAFK) { setAFK(true); }

    // Schedule the wake-up
    setTimeout(async () => {
        if (setAFK) { setAFK(false); }
        requestTimestamps = []; // clear rate limiter
        await client.user.setPresence({ status: 'online' });
        logger.info(`[RolyBot] AFK expired — back online`);
    }, duration * 1000);

    // Set presence to idle
    client.user.setPresence({ status: 'idle' });  
}

module.exports = {
    openai,
    generateValidStatus,
    recordRolybotRequest,
    tooManyRolybotRequests,
    goAFK
};