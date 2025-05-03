const MAX_REQUESTS = 20; // Max allowed in window
const WINDOW_SECONDS = 300; // Window duration (seconds)
const RATE_LIMIT_SECONDS = parseInt(process.env.RATE_LIMIT_SECONDS, 10) || 0;
const MAX_AFK_DURATION = parseInt(process.env.MAX_AFK_DURATION, 10) || 300; // Max AFK duration (seconds)

requestTimestamps = [];
rolybotBusy = false;

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

async function goAFK(duration = RATE_LIMIT_SECONDS, message) {
    rolybotBusy = false;
    
    if (duration > MAX_AFK_DURATION) {
        duration = MAX_AFK_DURATION;
        logger.warn(`[RolyBot] AFK duration limited to ${MAX_AFK_DURATION}s`);
    }

    logger.info(`[RolyBot] Going AFK for ${duration}s`);

    // Schedule the wake-up
    setTimeout(async () => {
        rolybotAFK = false;
        requestTimestamps = []; // clear rate limiter
        await client.user.setPresence({ status: 'online' });
        logger.info(`[RolyBot] AFK expired — back online`);
    }, duration * 1000);

    if (message) {
        // Generate a one-line “I’m going AFK” reply
        const afkNotice = await generateRolybotResponse({
            content: `You are a Discord bot that needs to take a ${duration}-second break. Generate one short line explaining you're going AFK.
                        You are replying to this message: ${message}`
        });

        await message.reply(afkNotice || "I'm going AFK for a bit. Be back soon!");
    }

    // Set presence to idle
    client.user.setPresence({ status: 'idle' });  
}