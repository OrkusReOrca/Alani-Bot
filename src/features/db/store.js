// SQLite storage for the tier/permission system itself, plus the actual
// reminders/events tables for the two new database kinds (general-user-db,
// general-server-db). Deliberately its OWN file/module, separate from
// orkus-info/db.js — orkus-info (the "Main" tier) stays completely
// untouched by this feature; nothing here is shared with or imported by
// it. Some duplication of orkus-info's schema/patterns (ensureColumn,
// the smallest-free-display-number scheme) is intentional, not an
// oversight — see the root README's "Tiers" section for why Main was
// kept separate rather than refactored to share code with these two.
//
// Same node:sqlite (built into Node, no native-module install risk) as
// orkus-info — see that file's own comment for the full reasoning.

import { DatabaseSync } from "node:sqlite";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "..", "..", "data", "db");
const DB_PATH = path.join(DATA_DIR, "db-core.db");

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS grants (
    user_id     TEXT NOT NULL,
    tier        TEXT NOT NULL CHECK (tier IN ('personal','server')),
    granted_at  TEXT NOT NULL,
    granted_by  TEXT NOT NULL,
    PRIMARY KEY (user_id, tier)
  );

  CREATE TABLE IF NOT EXISTS databases (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    kind               TEXT NOT NULL CHECK (kind IN ('user','server')),
    name               TEXT NOT NULL,
    owner_user_id      TEXT NOT NULL,
    guild_id           TEXT,
    primary_channel_id TEXT NOT NULL,
    status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','frozen')),
    created_at         TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS collaborators (
    database_id INTEGER NOT NULL REFERENCES databases(id),
    user_id     TEXT NOT NULL,
    added_at    TEXT NOT NULL,
    PRIMARY KEY (database_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS gen_reminders (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    database_id      INTEGER NOT NULL REFERENCES databases(id),
    text             TEXT NOT NULL,
    text_normalized  TEXT NOT NULL,
    remind_at        TEXT NOT NULL,
    created_at       TEXT NOT NULL,
    created_by       TEXT,
    channel_id       TEXT,
    display_number   INTEGER
  );

  CREATE TABLE IF NOT EXISTS gen_events (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    database_id      INTEGER NOT NULL REFERENCES databases(id),
    title            TEXT NOT NULL,
    title_normalized TEXT NOT NULL,
    start_time       TEXT NOT NULL,
    end_time         TEXT NOT NULL,
    created_at       TEXT NOT NULL,
    all_day          INTEGER DEFAULT 0,
    discord_event_id TEXT,
    location         TEXT
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type    TEXT NOT NULL,
    actor_user_id TEXT NOT NULL,
    database_id   INTEGER,
    detail        TEXT,
    channel_id    TEXT,
    guild_id      TEXT,
    created_at    TEXT NOT NULL
  );
`);

// ---------- audit log ----------
// Append-only history — "who did what, where, when" — for the two
// tiered database kinds only (NOT Main/orkus-info, kept fully untouched
// by this whole feature). Exists for two reasons: the admin `.a list db`
// view (see command.js) can show accessible-user history, and it's the
// groundwork for possible future cascade-revoking (e.g. tracing which
// collaborators a since-removed server-db owner had added). `detail` is
// a small JSON blob, shape depends on event_type — kept loose on purpose
// rather than a rigid column-per-field schema, since new event types
// will likely need different fields.

export function logEvent(eventType, actorUserId, { databaseId = null, detail = null, channelId = null, guildId = null } = {}) {
  db.prepare(
    `INSERT INTO audit_log (event_type, actor_user_id, database_id, detail, channel_id, guild_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(eventType, actorUserId, databaseId, detail ? JSON.stringify(detail) : null, channelId, guildId, new Date().toISOString());
}

export function getAuditLog(databaseId) {
  return db
    .prepare(`SELECT * FROM audit_log WHERE database_id = ? ORDER BY created_at ASC`)
    .all(databaseId)
    .map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
}

// ---------- tier grants ----------

export function hasGrant(userId, tier) {
  return Boolean(db.prepare(`SELECT 1 FROM grants WHERE user_id = ? AND tier = ?`).get(userId, tier));
}

export function grantTier(userId, tier, grantedBy, { channelId = null, guildId = null } = {}) {
  db.prepare(
    `INSERT INTO grants (user_id, tier, granted_at, granted_by) VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id, tier) DO UPDATE SET granted_at = excluded.granted_at, granted_by = excluded.granted_by`
  ).run(userId, tier, new Date().toISOString(), grantedBy);
  // Re-granting is a suspension being lifted, not a fresh start — any
  // database this user owns (not merely collaborates on) that got frozen
  // by a previous revoke comes back automatically.
  unfreezeOwnerDatabases(userId);
  logEvent("grant", grantedBy, { detail: { tier, targetUserId: userId }, channelId, guildId });
}

export function revokeTier(userId, tier, revokedBy, { channelId = null, guildId = null } = {}) {
  const result = db.prepare(`DELETE FROM grants WHERE user_id = ? AND tier = ?`).run(userId, tier);
  if (result.changes > 0) {
    freezeOwnerDatabases(userId);
    logEvent("revoke", revokedBy, { detail: { tier, targetUserId: userId }, channelId, guildId });
  }
  return result.changes > 0;
}

// ---------- database instances ----------

const RESERVED_NAMES = new Set([
  "main",
  "orkus-info",
  "grant",
  "revoke",
  "create",
  "drop",
  "collab",
  "transfer",
  // Second-level verbs too — a database literally named "add" would be
  // indistinguishable from the add-verb once resolution tried to match
  // args[0] against both a db name and (later) a verb.
  "add",
  "list",
  "delete",
  "edit",
]);

export function isReservedName(name) {
  return RESERVED_NAMES.has(name.toLowerCase());
}

export function countOwnedDatabases(userId, kind) {
  return db.prepare(`SELECT COUNT(*) AS n FROM databases WHERE owner_user_id = ? AND kind = ?`).get(userId, kind).n;
}

export function createDatabase({ kind, name, ownerUserId, guildId, primaryChannelId, channelId = null }) {
  const info = db
    .prepare(
      `INSERT INTO databases (kind, name, owner_user_id, guild_id, primary_channel_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(kind, name, ownerUserId, guildId, primaryChannelId, new Date().toISOString());
  logEvent("db_created", ownerUserId, { databaseId: info.lastInsertRowid, detail: { kind, name }, channelId, guildId });
  return getDatabaseById(info.lastInsertRowid);
}

export function getDatabaseById(id) {
  return db.prepare(`SELECT * FROM databases WHERE id = ?`).get(id);
}

// Resolves a name to a database instance the given user can actually
// reach — owner, collaborator (server-kind only), or (includeAll) a bot
// owner reaching across every instance regardless of ownership. Frozen
// instances are invisible unless includeAll is true (bot-owner override),
// matching "frozen = fully inaccessible to everyone except owner_0/1".
export function getDatabaseByName(name, userId, { includeAll = false } = {}) {
  const row = db.prepare(`SELECT * FROM databases WHERE LOWER(name) = LOWER(?)`).get(name);
  if (!row) return null;
  if (includeAll) return row;
  if (row.status !== "active") return null;
  if (row.owner_user_id === userId) return row;
  if (row.kind === "server") {
    const collab = db
      .prepare(`SELECT 1 FROM collaborators WHERE database_id = ? AND user_id = ?`)
      .get(row.id, userId);
    if (collab) return row;
  }
  return null;
}

// Every database instance a user can reach by name resolution — used when
// no db name is given in a command, to decide auto-select-the-only-one vs.
// ambiguous-must-specify. includeAll (bot owners) also returns frozen ones.
export function listAccessibleDatabases(userId, { includeAll = false } = {}) {
  if (includeAll) {
    return db.prepare(`SELECT * FROM databases ORDER BY name`).all();
  }
  return db
    .prepare(
      `SELECT DISTINCT d.* FROM databases d
       LEFT JOIN collaborators c ON c.database_id = d.id AND c.user_id = ?
       WHERE d.status = 'active' AND (d.owner_user_id = ? OR c.user_id IS NOT NULL)
       ORDER BY d.name`
    )
    .all(userId, userId);
}

// Every database (any kind, any status) recorded as created in a given
// guild — used by ".a list db" run by a bot owner inside a non-command-box
// guild channel. Includes frozen ones (same "owners can see everything"
// rule as the global list) and general-user-db instances too, even though
// those aren't actually restricted to that guild — guild_id there is
// purely informational (which server the create command happened to be
// run in), not an access boundary.
export function listDatabasesInGuild(guildId) {
  return db.prepare(`SELECT * FROM databases WHERE guild_id = ? ORDER BY kind, name`).all(guildId);
}

export function dropDatabase(id) {
  db.prepare(`DELETE FROM gen_reminders WHERE database_id = ?`).run(id);
  db.prepare(`DELETE FROM gen_events WHERE database_id = ?`).run(id);
  db.prepare(`DELETE FROM collaborators WHERE database_id = ?`).run(id);
  db.prepare(`DELETE FROM databases WHERE id = ?`).run(id);
}

function freezeOwnerDatabases(userId) {
  db.prepare(`UPDATE databases SET status = 'frozen' WHERE owner_user_id = ?`).run(userId);
}

function unfreezeOwnerDatabases(userId) {
  db.prepare(`UPDATE databases SET status = 'active' WHERE owner_user_id = ?`).run(userId);
}

export function transferOwnership(id, newOwnerUserId, actorUserId, { channelId = null, guildId = null } = {}) {
  db.prepare(`UPDATE databases SET owner_user_id = ?, status = 'active' WHERE id = ?`).run(newOwnerUserId, id);
  logEvent("transfer", actorUserId, { databaseId: id, detail: { newOwnerUserId }, channelId, guildId });
}

// ---------- collaborators (server-kind databases only) ----------

export function addCollaborator(databaseId, userId, actorUserId, { channelId = null, guildId = null } = {}) {
  db.prepare(
    `INSERT OR IGNORE INTO collaborators (database_id, user_id, added_at) VALUES (?, ?, ?)`
  ).run(databaseId, userId, new Date().toISOString());
  logEvent("collab_add", actorUserId, { databaseId, detail: { targetUserId: userId }, channelId, guildId });
}

export function removeCollaborator(databaseId, userId, actorUserId, { channelId = null, guildId = null } = {}) {
  const result = db.prepare(`DELETE FROM collaborators WHERE database_id = ? AND user_id = ?`).run(databaseId, userId);
  if (result.changes > 0) {
    logEvent("collab_remove", actorUserId, { databaseId, detail: { targetUserId: userId }, channelId, guildId });
  }
  return result.changes > 0;
}

export function listCollaborators(databaseId) {
  return db.prepare(`SELECT user_id FROM collaborators WHERE database_id = ? ORDER BY added_at`).all(databaseId).map((r) => r.user_id);
}

// ---------- smallest-free display_number, scoped per database_id ----------
// Same rule as orkus-info's own getNextDisplayNumber(), just scoped to one
// instance's reminders instead of a single global table.

export function getNextDisplayNumber(databaseId) {
  const used = new Set(
    db
      .prepare(`SELECT display_number FROM gen_reminders WHERE database_id = ? AND display_number IS NOT NULL`)
      .all(databaseId)
      .map((r) => r.display_number)
  );
  let n = 1;
  while (used.has(n)) n++;
  return n;
}

export default db;
