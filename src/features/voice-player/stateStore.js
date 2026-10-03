// Per-server voice player state in ONE SQLite file for every server —
// VoiceState.db, change-logged and backed up as its own group (see
// cloud-backup/groups.js). A server gets its rows the first time a voice command
// is used there.
//
// Two tables, split on purpose by how often they change:
//
//   guild_voice_state   the queue (a static list, in the order tracks were added)
//                       and the per-server switches. Changes only when someone
//                       adds/removes tracks or flips a switch.
//   guild_voice_cursor  just the index of the current track. Changes every time a
//                       track ends — so it's a few bytes, not a copy of the queue,
//                       in the change log that every cloud backup carries.
//
// Callers always load -> change -> save and never hold state in memory, so a
// backup restore (which swaps the database contents in place) can't leave a
// stale copy behind. saveState only writes what actually changed.

import { DatabaseSync } from "node:sqlite";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { installChangeLog } from "../cloud-backup/changeLog.js";
import { ensureColumn } from "../../common/sqlite.js";
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
  );

  -- No row means the cursor is at 0, which is also what every server saved before
  -- this table existed needs (their queue had the current track first).
  CREATE TABLE IF NOT EXISTS guild_voice_cursor (
    guild_id      TEXT PRIMARY KEY,
    current_index INTEGER NOT NULL
  );
`);
// Added after the table first shipped: servers that already have a row get these defaults.
ensureColumn(voiceDb, "guild_voice_state", "play_call", "INTEGER NOT NULL DEFAULT 1");
ensureColumn(voiceDb, "guild_voice_state", "persistent", "INTEGER NOT NULL DEFAULT 0");
installChangeLog(voiceDb);

// The server's state, or an empty one if it has none yet (nothing is written
// until the first saveState).
export function loadState(guildId) {
  const row = voiceDb.prepare(`SELECT queue_json, loop, shuffle, play_call, persistent FROM guild_voice_state WHERE guild_id = ?`).get(guildId);
  if (!row) return emptyState();
  const queue = JSON.parse(row.queue_json);
  const cursor = voiceDb.prepare(`SELECT current_index FROM guild_voice_cursor WHERE guild_id = ?`).get(guildId)?.current_index ?? 0;
  return {
    queue,
    cursor: Math.min(cursor, queue.length), // never past "ended", even if the two tables disagree
    loop: Boolean(row.loop),
    shuffle: Boolean(row.shuffle),
    playCall: Boolean(row.play_call),
    persistent: Boolean(row.persistent),
  };
}

export function saveState(guildId, state) {
  const queueJson = JSON.stringify(state.queue);
  const flags = [state.loop, state.shuffle, state.playCall, state.persistent].map((flag) => (flag ? 1 : 0));
  const stored = voiceDb.prepare(`SELECT queue_json, loop, shuffle, play_call, persistent FROM guild_voice_state WHERE guild_id = ?`).get(guildId);

  const unchanged = stored && stored.queue_json === queueJson && [stored.loop, stored.shuffle, stored.play_call, stored.persistent].every((value, i) => value === flags[i]);
  if (!unchanged) {
    voiceDb
      .prepare(
        `INSERT INTO guild_voice_state (guild_id, queue_json, loop, shuffle, play_call, persistent, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (guild_id) DO UPDATE SET queue_json = excluded.queue_json, loop = excluded.loop, shuffle = excluded.shuffle,
           play_call = excluded.play_call, persistent = excluded.persistent, updated_at = excluded.updated_at`
      )
      .run(guildId, queueJson, ...flags, new Date().toISOString());
  }

  const storedCursor = voiceDb.prepare(`SELECT current_index FROM guild_voice_cursor WHERE guild_id = ?`).get(guildId)?.current_index ?? 0;
  if (state.cursor !== storedCursor) {
    voiceDb
      .prepare(`INSERT INTO guild_voice_cursor (guild_id, current_index) VALUES (?, ?) ON CONFLICT (guild_id) DO UPDATE SET current_index = excluded.current_index`)
      .run(guildId, state.cursor);
  }
}
