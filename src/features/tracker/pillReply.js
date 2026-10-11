// A plain "yes" / "y" / "no" / "n" sent to the bot in a DM, right after a pill
// reminder, logs the pills that reminder asked about — no `.at logadd` needed.
//
// It only fires when there IS an unanswered reminder, never in a server, and
// never while the user is answering some other yes/no question (an .aii or
// delete confirmation), so a "yes" can't be counted twice.

import { isAwaitingConfirm } from "../../common/confirm.js";

const YES = /^(y|yes)$/i;
const NO = /^(n|no)$/i;

// Returns true if the message was a pill answer (and was handled).
export async function handlePillReply(message, { state, store, now = Date.now }) {
  if (message.guildId) return false;
  const text = message.content.trim();
  const taken = YES.test(text) ? true : NO.test(text) ? false : null;
  if (taken === null || isAwaitingConfirm(message.author.id, message.channelId)) return false;

  const prompt = state.takePending(message.author.id, now());
  if (!prompt) return false;

  const pills = prompt.pillIds.map((id) => store.getPill(id)).filter(Boolean); // a pill removed since is just skipped
  if (pills.length === 0) return false;
  for (const pill of pills) store.addPillLog(pill.id, taken, message.author.id, "reply");

  const names = pills.map((pill) => `**${pill.name}**`).join(", ");
  await message.reply({ content: taken ? `✅ Logged ${names} as taken.` : `📝 Logged ${names} as not taken. You can still log it later with \`.at la p <pill> y\`.`, allowedMentions: { repliedUser: false } });
  return true;
}
