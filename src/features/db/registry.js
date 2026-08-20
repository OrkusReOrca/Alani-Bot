// Registry of databases the ".a db" command can operate on. Each
// registered database exposes { add, list, delete, edit } — async
// functions taking (args: string[], ctx) and returning a reply string.
// ctx is the same one command.js's execute() received (userId,
// channelId, etc.) — e.g. reminders use ctx.userId to know who to DM by
// default. New databases (email, etc.) plug in from
// src/features/db/command.js by calling register(name, handlers) — see
// the orkus-info registration there for the pattern. Deliberately has no
// knowledge of any specific database itself, so it stays a plain lookup
// table.

const databases = new Map();

export const DEFAULT_DATABASE = "orkus-info";

export function register(name, handlers) {
  databases.set(name, handlers);
}

export function get(name) {
  return databases.get(name);
}

export function names() {
  return [...databases.keys()];
}
