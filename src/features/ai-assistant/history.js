// AIcommandHistory — everything .aii does, in its own SQLite file (change-
// logged and backed up like the other databases, see cloud-backup/groups.js).
//
//   ai_calls   one row per .aii request: who, where, what they said, what the
//              assistant finally answered, and the tokens it cost
//   ai_events  the steps inside a call, in order: each command it ran, what
//              that command replied, and any confirmation that was declined
//
// It also feeds the assistant's short per-user memory (recentTurns).

import { DatabaseSync } from "node:sqlite";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { installChangeLog } from "../cloud-backup/changeLog.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "..", "..", "data", "ai-history");

// A command's reply can be huge (a long list); the history keeps enough to
// understand what happened, not every byte.
const MAX_STORED_CHARS = 4000;
const MEMORY_RESULT_CHARS = 300;

fs.mkdirSync(DATA_DIR, { recursive: true });

export const historyDb = new DatabaseSync(path.join(DATA_DIR, "AIcommandHistory.db"));

historyDb.exec(`
  CREATE TABLE IF NOT EXISTS ai_calls (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at        TEXT NOT NULL,
    user_id           TEXT NOT NULL,
    channel_id        TEXT,
    guild_id          TEXT,
    user_text         TEXT NOT NULL,
    response_text     TEXT,
    model             TEXT,
    prompt_tokens     INTEGER DEFAULT 0,
    completion_tokens INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS ai_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    call_id    INTEGER NOT NULL REFERENCES ai_calls(id),
    created_at TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('command', 'result', 'declined')),
    content    TEXT NOT NULL
  );
`);
installChangeLog(historyDb);

const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);

export function startCall({ userId, channelId, guildId, userText, model }) {
  return Number(
    historyDb
      .prepare(`INSERT INTO ai_calls (created_at, user_id, channel_id, guild_id, user_text, model) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(new Date().toISOString(), userId, channelId, guildId, userText, model).lastInsertRowid
  );
}

export function recordEvent(callId, kind, content) {
  historyDb
    .prepare(`INSERT INTO ai_events (call_id, created_at, kind, content) VALUES (?, ?, ?, ?)`)
    .run(callId, new Date().toISOString(), kind, clip(content, MAX_STORED_CHARS));
}

export function finishCall(callId, { responseText, promptTokens, completionTokens }) {
  historyDb
    .prepare(`UPDATE ai_calls SET response_text = ?, prompt_tokens = ?, completion_tokens = ? WHERE id = ?`)
    .run(responseText ? clip(responseText, MAX_STORED_CHARS) : null, promptTokens, completionTokens, callId);
}

// The user's most recent finished calls within `withinMs`, oldest first, as
// chat messages: what they asked, then a plain-text account of what the
// assistant ran and said. Plain text (not replayed tool calls) keeps the
// memory cheap and format-independent.
export function recentTurns(userId, { limit, withinMs, now = Date.now() }) {
  const since = new Date(now - withinMs).toISOString();
  const calls = historyDb
    .prepare(`SELECT id, user_text, response_text FROM ai_calls WHERE user_id = ? AND created_at >= ? ORDER BY id DESC LIMIT ?`)
    .all(userId, since, limit)
    .reverse();

  return calls.flatMap((call) => {
    const events = historyDb.prepare(`SELECT kind, content FROM ai_events WHERE call_id = ? ORDER BY id`).all(call.id);
    const lines = events.map((e) =>
      e.kind === "command" ? `Ran \`${e.content}\`` : e.kind === "declined" ? `Not run (not confirmed): \`${e.content}\`` : `→ ${clip(e.content, MEMORY_RESULT_CHARS)}`
    );
    if (call.response_text) lines.push(call.response_text);
    return [
      { role: "user", content: call.user_text },
      { role: "assistant", content: lines.join("\n") || "(no answer was recorded)" },
    ];
  });
}
