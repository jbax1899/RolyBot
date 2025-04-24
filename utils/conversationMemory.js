const MAX_HISTORY = 20;

/**
 * Fetches the last MAX_HISTORY messages from the given TextChannel,
 * sorts them oldest→newest, and maps them into
 * { role: 'user'|'assistant', content, username } entries.
 *
 * Only messages authored by _this_ bot become role:'assistant'.
 * Everyone else (people or other bots) are role:'user'.
 */
async function loadPosts(channel, limit = MAX_HISTORY) {
  // fetch the most recent `limit` messages
  const fetched = await channel.messages.fetch({ limit });

  // sort oldest→newest
  const sorted = Array.from(fetched.values())
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp);

  // grab _this_ bot's ID
  const myBotId = channel.client.user.id;

  // map into our chat‑format
  return sorted.map(m => {
    const isMe = m.author.id === myBotId;
    return {
      role:     isMe ? 'assistant' : 'user',
      // if it's _not_ me, prepend the username so the LLM knows who said what
      content:  isMe
                ? m.content
                : `${m.author.username}: ${m.content}`,
      username: m.author.username
    };
  });
}

module.exports = { loadPosts, MAX_HISTORY };