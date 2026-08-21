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
