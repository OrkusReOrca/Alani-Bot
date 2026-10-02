// Parsing of prefix commands. The prefix is its own token: ".a" alone or
// ".a <command> ..." match; "someword.a" or ".abc" don't.

export const PREFIX = ".a";

// Splits ".a <name> [args...]" into { name, args }, or null if `content`
// isn't a prefix command at all. Splits purely on whitespace (quoted fields
// are re-joined by textParsing.js's extractQuoted, where a command needs them).
export function parsePrefixCommand(content) {
  if (content !== PREFIX && !content.startsWith(`${PREFIX} `)) return null;
  const tokens = content.slice(PREFIX.length).trim().split(/\s+/).filter(Boolean);
  return { name: tokens[0]?.toLowerCase(), args: tokens.slice(1) };
}
