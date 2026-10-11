// Parsing of prefix commands. A prefix is its own token: ".a" alone or
// ".a <command> ..." match; "someword.a" or ".abc" don't.
//
//   .a <name> [args...]   the general form
//   .avc [args...]        shorthand for the voice player (command "avc")
//   .at  [args...]        shorthand for the trackers (command "at")
//
// In a DM with the bot the leading ".a" can be dropped: "info", "db list",
// "t bp list" (= ".at bp list") and "vc list" (= ".avc list") all work. The
// ".a" forms keep working there too.

// What a dropped prefix means for the shorthand commands: ".at" -> "t", ".avc" -> "vc".
const DM_SHORTHANDS = { t: "at", vc: "avc" };

// Splits a command line into { name, args }, or null if it isn't a command.
// Splits purely on whitespace (quoted fields are re-joined where a command needs
// them). In a DM (`dm: true`) any first word is taken as a command name — the
// caller drops it if no such command exists, so ordinary chat is ignored.
export function parseCommandLine(content, { dm = false } = {}) {
  const tokens = content.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  if (tokens[0] === ".a") return { name: tokens[1]?.toLowerCase(), args: tokens.slice(2) };
  const dotted = { ".avc": "avc", ".at": "at" }[tokens[0].toLowerCase()];
  if (dotted) return { name: dotted, args: tokens.slice(1) };

  if (!dm) return null;
  const first = tokens[0].toLowerCase();
  return { name: DM_SHORTHANDS[first] ?? first, args: tokens.slice(1) };
}
