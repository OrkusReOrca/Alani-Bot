// Per-server voice player state (queue, loop, shuffle) in ONE SQLite file for
// every server — VoiceState.db, change-logged and backed up as its own group
// (see cloud-backup/groups.js). A server gets its row the first time a voice
// command is used there.
//
// Callers always load -> change -> save and never hold state in memory, so a
// backup restore (which swaps the database contents in place) can't leave a
// stale copy behind.

import { DatabaseSync } from "node:sqlite";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { installChangeLog } from "../cloud-backup/changeLog.js";
import { emptyState } from "./queue.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "..", "..", "data", "voice");

fs.mkdirSync(DATA_DIR, { recursive: true });

export const voiceDb = new DatabaseSync(path.join(DATA_DIR, "VoiceState.db"));

voiceDb.exec(`
  CREATE TABLE IF NOT EXISTS guild_voice_state (
    guild_id   TEXT PRIMARY KEY,
    queue_json TEXT NOT NULL,
    loop       INTEGER NOT NULL DEFAULT 0,
    shuffle    INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  )
`);
installChangeLog(voiceDb);

// The server's state, or an empty one if it has none yet (nothing is written
// until the first saveState).
export function loadState(guildId) {
  const row = voiceDb.prepare(`SELECT queue_json, loop, shuffle FROM guild_voice_state WHERE guild_id = ?`).get(guildId);
  if (!row) return emptyState();
  return { queue: JSON.parse(row.queue_json), loop: Boolean(row.loop), shuffle: Boolean(row.shuffle) };
}

export function saveState(guildId, state) {
  voiceDb
    .prepare(
      `INSERT INTO guild_voice_state (guild_id, queue_json, loop, shuffle, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (guild_id) DO UPDATE SET queue_json = excluded.queue_json, loop = excluded.loop,
         shuffle = excluded.shuffle, updated_at = excluded.updated_at`
    )
    .run(guildId, JSON.stringify(state.queue), state.loop ? 1 : 0, state.shuffle ? 1 : 0, new Date().toISOString());
}
