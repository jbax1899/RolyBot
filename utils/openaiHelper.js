const OpenAI = require("openai");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const typeMap = { Playing: 0, Streaming: 1, Listening: 2, Watching: 3 };
const typeNames = Object.keys(typeMap);
const STATUS_MODEL = "gpt-4o-mini";
const tokenHandlers = {
    websearch: handleWebSearch,
    search: handleWebSearch,
};
const TOKEN_REGEX = /\[(\w+)="([^"]+)"\]/g;
const RETURN_RESULTS = 3;

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

/**
 * Extract all tokens from a string and resolve them via their handlers.
 * @param {string} text
 * @returns {Promise<Object>} object like { search: "Results...", weather: "Results..." }
 */
async function processSpecialTokens(text) {
    // Find all tokens: [type="content"]
    const matches = Array.from(text.matchAll(TOKEN_REGEX));
    const results = {};

    for (let [, type, content] of matches) {
        if (tokenHandlers[type]) {
            try {
                results[type] = await tokenHandlers[type](content);
            } catch (e) {
                results[type] = `Error handling ${type}: ${e.message}`;
            }
        }
    }
    return results;
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
        }

        // Build a single JSON array: first element = the query, then up to X result‐objects
        const resultsArray = [
            { query }   // 1) always include the original query as the first item
        ].concat(
            items.slice(0, RETURN_RESULTS).map(item => ({
                title: item.title || null,
                //htmlTitle: item.htmlTitle || null,
                snippet: item.snippet || null,
                //htmlSnippet: item.htmlSnippet || null,
                link: item.link || null,
                //displayLink: item.displayLink || null,
                //formattedUrl: item.formattedUrl || null,
                //htmlFormattedUrl: item.htmlFormattedUrl || null,
                //pagemap: item.pagemap || {} // any extra metadata Google gives
            }))
        );

        return JSON.stringify(resultsArray, null, 2);

    } catch (err) {
        console.warn(`[handleWebSearch] error for "${query}":`, err.message);
        return `Error performing web search for "${query}": ${err.message}`;
    }
}

module.exports = {
    openai,
    generateValidStatus,
    processSpecialTokens
};