// The tracker database: one file (Tracker.db) holding EVERY kind of tracker —
// their settings and their data — so the cloud backup needs just one file for
// the whole feature. Built from a connection so tests can use an in-memory one;
// store.js wires the real file.
//
//   trackers             one row per tracker, bound to a user or a server
//   tracker_settings     reminder schedule, timezone, message, who to tag, where to send
//   tracker_permissions  who may use an owner's trackers besides the owner
//   bp_logs              blood pressure readings
//   pills / pill_logs    the pills of a Pill tracker, and taken / not-taken logs
//
// Times are stored as UTC ISO strings. Everything is change-logged (see
// cloud-backup/changeLog.js), so every write is part of the backup.

import { installChangeLog } from "../cloud-backup/changeLog.js";
import { TYPES } from "./types.js";

export class TrackerError extends Error {}

export const OWNER_KINDS = { user: "user", guild: "guild" };
const DEFAULT_TZ_MINUTES = 7 * 60;

export function createTrackerStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS trackers (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      type       TEXT NOT NULL,
      name       TEXT NOT NULL,
      owner_kind TEXT NOT NULL CHECK (owner_kind IN ('user','guild')),
      owner_id   TEXT NOT NULL,
      created_by TEXT NOT NULL,
      enabled    INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS trackers_owner_name ON trackers (owner_kind, owner_id, name COLLATE NOCASE);

    CREATE TABLE IF NOT EXISTS tracker_settings (
      tracker_id INTEGER PRIMARY KEY REFERENCES trackers(id),
      spec_json  TEXT,
      tz_minutes INTEGER NOT NULL DEFAULT ${DEFAULT_TZ_MINUTES},
      message    TEXT,
      tag_ids    TEXT NOT NULL DEFAULT '',
      sent_to    TEXT NOT NULL DEFAULT 'dm'
    );

    CREATE TABLE IF NOT EXISTS tracker_permissions (
      owner_kind TEXT NOT NULL,
      owner_id   TEXT NOT NULL,
      user_id    TEXT NOT NULL,
      granted_by TEXT NOT NULL,
      granted_at TEXT NOT NULL,
      PRIMARY KEY (owner_kind, owner_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS bp_logs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      tracker_id INTEGER NOT NULL REFERENCES trackers(id),
      systolic   INTEGER NOT NULL,
      diastolic  INTEGER NOT NULL,
      logged_at  TEXT NOT NULL,
      logged_by  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pills (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      tracker_id INTEGER NOT NULL REFERENCES trackers(id),
      name       TEXT NOT NULL,
      alias      TEXT,
      spec_json  TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS pills_tracker_name ON pills (tracker_id, name COLLATE NOCASE);

    CREATE TABLE IF NOT EXISTS pill_logs (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      pill_id   INTEGER NOT NULL REFERENCES pills(id),
      taken     INTEGER NOT NULL,
      logged_at TEXT NOT NULL,
      logged_by TEXT NOT NULL,
      source    TEXT NOT NULL
    );
  `);
  installChangeLog(db);

  const one = (sql, ...params) => db.prepare(sql).get(...params);
  const all = (sql, ...params) => db.prepare(sql).all(...params);
  const run = (sql, ...params) => db.prepare(sql).run(...params);
  const inList = (ids) => ids.map(() => "?").join(", ");

  const trackerOf = (row) => row ? { id: row.id, type: row.type, name: row.name, ownerKind: row.owner_kind, ownerId: row.owner_id, createdBy: row.created_by, enabled: Boolean(row.enabled), createdAt: row.created_at } : null;
  const pillOf = (row) => row ? { id: row.id, trackerId: row.tracker_id, name: row.name, alias: row.alias, spec: JSON.parse(row.spec_json) } : null;
  const logOf = (row) => ({ id: row.id, loggedAt: row.logged_at, loggedBy: row.logged_by });

  return {
    // ---------- trackers ----------
    createTracker({ type, name, ownerKind, ownerId, createdBy }) {
      if (!TYPES[type]) throw new TrackerError(`Unknown tracker type "${type}".`);
      if (TYPES[type].onePerOwner && this.findByType(ownerKind, ownerId, type)) throw new TrackerError(`There's already a ${TYPES[type].name} here.`);
      if (this.findByName(ownerKind, ownerId, name)) throw new TrackerError(`There's already a tracker called "${name}" here.`);
      const info = run(`INSERT INTO trackers (type, name, owner_kind, owner_id, created_by, enabled, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)`, type, name, ownerKind, ownerId, createdBy, new Date().toISOString());
      return this.getTracker(Number(info.lastInsertRowid));
    },
    getTracker: (id) => trackerOf(one(`SELECT * FROM trackers WHERE id = ?`, id)),
    findByName: (ownerKind, ownerId, name) => trackerOf(one(`SELECT * FROM trackers WHERE owner_kind = ? AND owner_id = ? AND name = ? COLLATE NOCASE`, ownerKind, ownerId, name)),
    findByType: (ownerKind, ownerId, type) => trackerOf(one(`SELECT * FROM trackers WHERE owner_kind = ? AND owner_id = ? AND type = ? ORDER BY id LIMIT 1`, ownerKind, ownerId, type)),
    listTrackers: (ownerKind, ownerId) => all(`SELECT * FROM trackers WHERE owner_kind = ? AND owner_id = ? ORDER BY id`, ownerKind, ownerId).map(trackerOf),
    listEnabledTrackers: () => all(`SELECT * FROM trackers WHERE enabled = 1 ORDER BY id`).map(trackerOf),
    setEnabled: (id, enabled) => run(`UPDATE trackers SET enabled = ? WHERE id = ?`, enabled ? 1 : 0, id),
    // Did this user create any tracker for the owner (the "owner" of a server's trackers)?
    createdAnyFor: (ownerKind, ownerId, userId) => Boolean(one(`SELECT 1 FROM trackers WHERE owner_kind = ? AND owner_id = ? AND created_by = ?`, ownerKind, ownerId, userId)),

    // ---------- settings ----------
    getSettings(trackerId) {
      const row = one(`SELECT * FROM tracker_settings WHERE tracker_id = ?`, trackerId);
      return {
        spec: row?.spec_json ? JSON.parse(row.spec_json) : null, // raw schedule words: { recurring, words, at }
        tzMinutes: row?.tz_minutes ?? DEFAULT_TZ_MINUTES,
        message: row?.message ?? null,
        tagIds: row?.tag_ids ? row.tag_ids.split(",") : [],
        sentTo: row?.sent_to ?? "dm",
      };
    },
    // Writes the settings (the caller passes the complete new value).
    saveSettings(trackerId, { spec, tzMinutes, message, tagIds, sentTo }) {
      run(
        `INSERT INTO tracker_settings (tracker_id, spec_json, tz_minutes, message, tag_ids, sent_to) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (tracker_id) DO UPDATE SET spec_json = excluded.spec_json, tz_minutes = excluded.tz_minutes,
           message = excluded.message, tag_ids = excluded.tag_ids, sent_to = excluded.sent_to`,
        trackerId, spec ? JSON.stringify(spec) : null, tzMinutes, message, tagIds.join(","), sentTo
      );
    },

    // ---------- permissions ----------
    grant(ownerKind, ownerId, userId, grantedBy) {
      return run(`INSERT OR IGNORE INTO tracker_permissions (owner_kind, owner_id, user_id, granted_by, granted_at) VALUES (?, ?, ?, ?, ?)`, ownerKind, ownerId, userId, grantedBy, new Date().toISOString()).changes > 0;
    },
    revoke: (ownerKind, ownerId, userId) => run(`DELETE FROM tracker_permissions WHERE owner_kind = ? AND owner_id = ? AND user_id = ?`, ownerKind, ownerId, userId).changes > 0,
    hasGrant: (ownerKind, ownerId, userId) => Boolean(one(`SELECT 1 FROM tracker_permissions WHERE owner_kind = ? AND owner_id = ? AND user_id = ?`, ownerKind, ownerId, userId)),
    listGrants: (ownerKind, ownerId) => all(`SELECT user_id FROM tracker_permissions WHERE owner_kind = ? AND owner_id = ? ORDER BY granted_at`, ownerKind, ownerId).map((r) => r.user_id),

    // ---------- blood pressure ----------
    addBpLog(trackerId, systolic, diastolic, loggedBy, at = new Date()) {
      run(`INSERT INTO bp_logs (tracker_id, systolic, diastolic, logged_at, logged_by) VALUES (?, ?, ?, ?, ?)`, trackerId, systolic, diastolic, at.toISOString(), loggedBy);
    },
    // Newest first.
    listBpLogs: (trackerId) => all(`SELECT * FROM bp_logs WHERE tracker_id = ? ORDER BY logged_at DESC, id DESC`, trackerId).map((r) => ({ ...logOf(r), systolic: r.systolic, diastolic: r.diastolic })),
    deleteBpLogs(ids) {
      return ids.length === 0 ? 0 : run(`DELETE FROM bp_logs WHERE id IN (${inList(ids)})`, ...ids).changes;
    },
    hasBpLogBetween: (trackerId, startMs, endMs) => Boolean(one(`SELECT 1 FROM bp_logs WHERE tracker_id = ? AND logged_at >= ? AND logged_at < ?`, trackerId, new Date(startMs).toISOString(), new Date(endMs).toISOString())),

    // ---------- pills ----------
    addPill(trackerId, { name, alias, spec }) {
      if (this.findPill(trackerId, name) || (alias && this.findPill(trackerId, alias))) throw new TrackerError(`There's already a pill called "${name}"${alias ? ` / "${alias}"` : ""}.`);
      const info = run(`INSERT INTO pills (tracker_id, name, alias, spec_json, created_at) VALUES (?, ?, ?, ?, ?)`, trackerId, name, alias ?? null, JSON.stringify(spec), new Date().toISOString());
      return this.getPill(Number(info.lastInsertRowid));
    },
    getPill: (id) => pillOf(one(`SELECT * FROM pills WHERE id = ?`, id)),
    // By full name or alias, ignoring case.
    findPill: (trackerId, text) => pillOf(one(`SELECT * FROM pills WHERE tracker_id = ? AND (name = ? COLLATE NOCASE OR alias = ? COLLATE NOCASE) ORDER BY id LIMIT 1`, trackerId, text, text)),
    listPills: (trackerId) => all(`SELECT * FROM pills WHERE tracker_id = ? ORDER BY id`, trackerId).map(pillOf),
    removePill(id) {
      run(`DELETE FROM pill_logs WHERE pill_id = ?`, id);
      return run(`DELETE FROM pills WHERE id = ?`, id).changes > 0;
    },

    addPillLog(pillId, taken, loggedBy, source, at = new Date()) {
      run(`INSERT INTO pill_logs (pill_id, taken, logged_at, logged_by, source) VALUES (?, ?, ?, ?, ?)`, pillId, taken ? 1 : 0, at.toISOString(), loggedBy, source);
    },
    // Logs of the given pills, newest first, with each pill's name.
    listPillLogs(pillIds) {
      if (pillIds.length === 0) return [];
      return all(
        `SELECT l.*, p.name AS pill_name FROM pill_logs l JOIN pills p ON p.id = l.pill_id WHERE l.pill_id IN (${inList(pillIds)}) ORDER BY l.logged_at DESC, l.id DESC`,
        ...pillIds
      ).map((r) => ({ ...logOf(r), pillId: r.pill_id, pillName: r.pill_name, taken: Boolean(r.taken), source: r.source }));
    },
    deletePillLogs(ids) {
      return ids.length === 0 ? 0 : run(`DELETE FROM pill_logs WHERE id IN (${inList(ids)})`, ...ids).changes;
    },
    wasPillTakenBetween: (pillId, startMs, endMs) => Boolean(one(`SELECT 1 FROM pill_logs WHERE pill_id = ? AND taken = 1 AND logged_at >= ? AND logged_at < ?`, pillId, new Date(startMs).toISOString(), new Date(endMs).toISOString())),
  };
}
