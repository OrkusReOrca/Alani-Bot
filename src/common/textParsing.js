// Extracts a double-quoted "name" field (reminder text, event title, and
// any future free-text field) from a chat-command token array — the
// standard going forward for any field that needs to safely contain
// spaces, commas, emoji, or anything else that would otherwise collide
// with this repo's space-separated, trailing-modifier command grammar.
//
// The tokens arriving here are already split on whitespace by bot.js's
// own message tokenizer (it has no quote-awareness at all), so a typed
// `"hello there"` arrives as two separate tokens, `"hello` and `there"`,
// that have to be re-joined here rather than parsed as a single string.

export function extractQuoted(tokens) {
  const startIdx = tokens.findIndex((t) => t.startsWith('"'));
  if (startIdx === -1) return null;

  let endIdx = -1;
  for (let i = startIdx; i < tokens.length; i++) {
    // A single-character `"` token can't close itself at i === startIdx —
    // that would treat an empty `""` opener as already-closed before any
    // content. Anywhere past that, a token ending in `"` closes it.
    if (tokens[i].endsWith('"') && (i > startIdx || tokens[i].length > 1)) {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) return null;

  const raw = tokens.slice(startIdx, endIdx + 1).join(" ");
  const text = raw.slice(1, -1);
  return { before: tokens.slice(0, startIdx), text, after: tokens.slice(endIdx + 1) };
}

// Case- and whitespace-insensitive form of a name field, used for duplicate
// detection.
export function normalizeText(text) {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

// Pulls trailing modifier tokens (any order) off the end of an args list
// that's ALREADY had its quoted "name" field extracted (see
// common/textParsing.js's extractQuoted) — so what's left here is only
// ever modifiers, never reminder text itself: "force" (skip the
// duplicate check), a bare Discord snowflake (channel to post in,
// instead of DMing the creator), and — reminders only — one mentions
// token (comma-separated user IDs/usernames, or a single one; see
// common/mentions.js). A single bare numeric mention with no comma is
// indistinguishable from a channel-id and resolves as one — a known,
// accepted limitation; use a comma (even for one entry) or a username
// to avoid the ambiguity.
export function stripTrailingModifiers(args, { allowMentions = false } = {}) {
  const rest = [...args];
  let force = false;
  let channelId = null;
  let mentions = null;

  while (rest.length > 0) {
    const last = rest[rest.length - 1];
    if (last.toLowerCase() === "force") {
      force = true;
      rest.pop();
    } else if (/^\d{15,20}$/.test(last)) {
      channelId = last;
      rest.pop();
    } else if (allowMentions && mentions === null) {
      mentions = last;
      rest.pop();
    } else {
      break;
    }
  }
  return { rest, force, channelId, mentions };
}
