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
//
// The same queue state also holds each Alatomy account's personal queue (the
// web app's "On account" player), under the id "account:<account id>" instead
// of a server id. Two small tables serve the web app: which servers a person
// used the player in lately, and when each file was last played.

import { DatabaseSync } from "node:sqlite";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { installChangeLog } from "../cloud-backup/changeLog.js";
import { ensureColumn } from "../../common/sqlite.js";
import { emptyState } from "./queue.js";
import { stoppedPlayback } from "./personalPlayback.js";

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

  -- Where the bot was when it last stopped: the call it is in (null = not in one) and the text channel
  -- its "Now playing" messages go to. Lets a restart rejoin the call and carry on.
  CREATE TABLE IF NOT EXISTS voice_guild_users (
    guild_id     TEXT NOT NULL,
    user_id      TEXT NOT NULL,
    last_used_at TEXT NOT NULL,
    PRIMARY KEY (guild_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS voice_play_history (
    file_id        TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    plays          INTEGER NOT NULL DEFAULT 0,
    last_played_at TEXT NOT NULL
  );

  -- Where a personal queue is in its song, shared by the person's devices (personalPlayback.js).
  CREATE TABLE IF NOT EXISTS personal_playback (
    queue_id    TEXT PRIMARY KEY,
    playing     INTEGER NOT NULL,
    position_ms INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    rev         INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS guild_voice_presence (
    guild_id         TEXT PRIMARY KEY,
    voice_channel_id TEXT,
    text_channel_id  TEXT
  );
`);
// Added after the table first shipped: servers that already have a row get these defaults.
ensureColumn(voiceDb, "guild_voice_state", "play_call", "INTEGER NOT NULL DEFAULT 1");
ensureColumn(voiceDb, "guild_voice_state", "persistent", "INTEGER NOT NULL DEFAULT 0");
ensureColumn(voiceDb, "personal_playback", "waiting", "INTEGER NOT NULL DEFAULT 0");
ensureColumn(voiceDb, "guild_voice_cursor", "up_next", "INTEGER"); // shuffle's next track, drawn ahead (queue.js)
installChangeLog(voiceDb);

// The server's state, or an empty one if it has none yet (nothing is written
// until the first saveState).
export function loadState(guildId) {
  const row = voiceDb.prepare(`SELECT queue_json, loop, shuffle, play_call, persistent FROM guild_voice_state WHERE guild_id = ?`).get(guildId);
  if (!row) return emptyState();
  const queue = JSON.parse(row.queue_json);
  const position = voiceDb.prepare(`SELECT current_index, up_next FROM guild_voice_cursor WHERE guild_id = ?`).get(guildId);
  const cursor = position?.current_index ?? 0;
  return {
    queue,
    cursor: Math.min(cursor, queue.length), // never past "ended", even if the two tables disagree
    upNext: position?.up_next ?? null,
    loop: Boolean(row.loop),
    shuffle: Boolean(row.shuffle),
    playCall: Boolean(row.play_call),
    persistent: Boolean(row.persistent),
  };
}

export function loadPresence(guildId) {
  const row = voiceDb.prepare(`SELECT voice_channel_id, text_channel_id FROM guild_voice_presence WHERE guild_id = ?`).get(guildId);
  return { voiceChannelId: row?.voice_channel_id ?? null, textChannelId: row?.text_channel_id ?? null };
}

// Pass only the fields to change: savePresence(guild, { voiceChannelId: null }).
export function savePresence(guildId, change) {
  const next = { ...loadPresence(guildId), ...change };
  voiceDb
    .prepare(
      `INSERT INTO guild_voice_presence (guild_id, voice_channel_id, text_channel_id) VALUES (?, ?, ?)
       ON CONFLICT (guild_id) DO UPDATE SET voice_channel_id = excluded.voice_channel_id, text_channel_id = excluded.text_channel_id`
    )
    .run(guildId, next.voiceChannelId, next.textChannelId);
}

// Servers that were in a call when the bot last stopped.
export function listGuildsInCall() {
  return voiceDb.prepare(`SELECT guild_id, voice_channel_id FROM guild_voice_presence WHERE voice_channel_id IS NOT NULL`).all().map((row) => ({ guildId: row.guild_id, voiceChannelId: row.voice_channel_id }));
}

// Servers with something queued (their tracks must be kept and re-converted after a restart).
// Personal queues are not included: they play in a browser, not through the bot.
export function listGuildsWithQueue() {
  return voiceDb.prepare(`SELECT guild_id FROM guild_voice_state WHERE queue_json <> '[]' AND guild_id NOT LIKE 'account:%'`).all().map((row) => row.guild_id);
}

export function loadPlayback(queueId) {
  const row = voiceDb.prepare(`SELECT playing, position_ms, updated_at, rev, waiting FROM personal_playback WHERE queue_id = ?`).get(queueId);
  return row ? { playing: Boolean(row.playing), positionMs: row.position_ms, updatedAt: row.updated_at, rev: row.rev, waiting: Boolean(row.waiting) } : stoppedPlayback();
}

export function savePlayback(queueId, pb) {
  voiceDb
    .prepare(
      `INSERT INTO personal_playback (queue_id, playing, position_ms, updated_at, rev, waiting) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (queue_id) DO UPDATE SET playing = excluded.playing, position_ms = excluded.position_ms, updated_at = excluded.updated_at, rev = excluded.rev, waiting = excluded.waiting`
    )
    .run(queueId, pb.playing ? 1 : 0, pb.positionMs, pb.updatedAt, pb.rev, pb.waiting ? 1 : 0);
}

/** The state id of an Alatomy account's personal queue. */
export const personalQueueId = (accountId) => `account:${accountId}`;

// Someone used the player in a server (the web app lists those servers first).
export function noteGuildUser(guildId, userId, at = new Date()) {
  voiceDb
    .prepare(`INSERT INTO voice_guild_users (guild_id, user_id, last_used_at) VALUES (?, ?, ?) ON CONFLICT (guild_id, user_id) DO UPDATE SET last_used_at = excluded.last_used_at`)
    .run(guildId, userId, at.toISOString());
}

// guild id -> when this person last used the player there.
export function guildsUsedBy(userId) {
  return new Map(voiceDb.prepare(`SELECT guild_id, last_used_at FROM voice_guild_users WHERE user_id = ?`).all(userId).map((row) => [row.guild_id, row.last_used_at]));
}

export function recordPlay(fileId, name, at = new Date()) {
  voiceDb
    .prepare(
      `INSERT INTO voice_play_history (file_id, name, plays, last_played_at) VALUES (?, ?, 1, ?)
       ON CONFLICT (file_id) DO UPDATE SET name = excluded.name, plays = plays + 1, last_played_at = excluded.last_played_at`
    )
    .run(fileId, name, at.toISOString());
}

// file id -> { plays, lastPlayedAt }
export function playHistory() {
  return new Map(voiceDb.prepare(`SELECT file_id, plays, last_played_at FROM voice_play_history`).all().map((row) => [row.file_id, { plays: row.plays, lastPlayedAt: row.last_played_at }]));
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

  const position = voiceDb.prepare(`SELECT current_index, up_next FROM guild_voice_cursor WHERE guild_id = ?`).get(guildId);
  const upNext = Number.isInteger(state.upNext) ? state.upNext : null;
  if (state.cursor !== (position?.current_index ?? 0) || upNext !== (position?.up_next ?? null)) {
    voiceDb
      .prepare(`INSERT INTO guild_voice_cursor (guild_id, current_index, up_next) VALUES (?, ?, ?) ON CONFLICT (guild_id) DO UPDATE SET current_index = excluded.current_index, up_next = excluded.up_next`)
      .run(guildId, state.cursor, upNext);
  }
}
