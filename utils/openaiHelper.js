// openaiHelper.js
const OpenAI = require("openai");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const typeMap = { Playing: 0, Streaming: 1, Listening: 2, Watching: 3 };
const typeNames = Object.keys(typeMap);
const STATUS_MODEL = "gpt-4o-mini";

async function generateValidStatus(context = "", maxAttempts = 3) {
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

module.exports = { openai, generateValidStatus };