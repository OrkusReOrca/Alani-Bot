// Parsing of prefix commands. A prefix is its own token: ".a" alone or
// ".a <command> ..." match; "someword.a" or ".abc" don't.
//
//   .a <name> [args...]   the general form
//   .avc [args...]        shorthand for the voice player (command "avc")

// Splits a command line into { name, args }, or null if it isn't a prefix
// command at all. Splits purely on whitespace (quoted fields are re-joined by
// textParsing.js's extractQuoted, where a command needs them).
export function parseCommandLine(content) {
  const tokens = content.trim().split(/\s+/).filter(Boolean);
  if (tokens[0] === ".a") return { name: tokens[1]?.toLowerCase(), args: tokens.slice(2) };
  if (tokens[0]?.toLowerCase() === ".avc") return { name: "avc", args: tokens.slice(1) };
  return null;
}
