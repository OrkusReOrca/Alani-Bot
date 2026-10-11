// Asks the user to confirm something and waits for their next message.
//
// While a question is open, the user's next message in that channel belongs to
// it — isAwaitingConfirm() lets other "a plain yes/no in a DM means something"
// handlers (like the pill reminder reply) stay out of the way.

const YES = /^(y|yes|yep|confirm|ok|sure|do it)\b/i;
const DEFAULT_TIMEOUT_MS = 60 * 1000;

const waiting = new Set();
const keyOf = (userId, channelId) => `${userId}:${channelId}`;

export const isAwaitingConfirm = (userId, channelId) => waiting.has(keyOf(userId, channelId));

// Posts `prompt` as a reply to `message`, then resolves true if the same user's
// next message in that channel says yes within the timeout, false otherwise.
export async function awaitConfirmation(message, prompt, { timeoutMs = DEFAULT_TIMEOUT_MS, allowedMentions = { parse: ["users"], repliedUser: false } } = {}) {
  const key = keyOf(message.author.id, message.channelId);
  waiting.add(key);
  try {
    await message.reply({ content: prompt, allowedMentions });
    const answers = await message.channel.awaitMessages({ filter: (m) => m.author.id === message.author.id, max: 1, time: timeoutMs });
    return YES.test(answers.first()?.content.trim() ?? "");
  } finally {
    waiting.delete(key);
  }
}
