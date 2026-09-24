// Row-level change log kept INSIDE each backed-up SQLite database.
//
// installChangeLog() adds a `change_log` table plus AFTER INSERT / UPDATE /
// DELETE triggers on every data table, so every write is recorded no matter
// which code path (or out-of-band tool) made it. Each entry stores the full
// row image, which is what lets the backup verifier replay the log on top of
// an older snapshot and check that the result matches the live database —
// see verify.js. The log lives in the database itself, so a snapshot of the
// database carries its own history with it.
//
// Call installChangeLog() AFTER a module's schema and migrations are final
// (triggers list columns explicitly, so they must be recreated whenever the
// columns change) and BEFORE any startup data backfill, so the backfill is
// logged too.

import crypto from "crypto";

export const CHANGE_LOG_TABLE = "change_log";

const SAFE_IDENTIFIER = /^\w+$/;

function quoteIdentifier(name) {
  if (!SAFE_IDENTIFIER.test(name)) throw new Error(`Unsupported SQL identifier "${name}"`);
  return `"${name}"`;
}

// Every user table that carries data worth backing up (everything except
// SQLite internals and the log itself), in name order.
export function listDataTables(db) {
  return db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> ? ORDER BY name`)
    .all(CHANGE_LOG_TABLE)
    .map((r) => r.name);
}

export function columnNames(db, table) {
  return db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all().map((c) => c.name);
}

// Primary-key columns in key order. Every backed-up table must have an
// explicit primary key: it's how a logged row is matched during replay.
export function primaryKeyColumns(db, table) {
  const keys = db
    .prepare(`PRAGMA table_info(${quoteIdentifier(table)})`)
    .all()
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);
  if (keys.length === 0) throw new Error(`Table "${table}" has no primary key — the change log can't track it`);
  return keys;
}

const TRIGGER_PREFIX = "changelog_";

function triggerName(table, suffix) {
  return `${TRIGGER_PREFIX}${table}_${suffix}`;
}

export function removeChangeLogTriggers(db) {
  const triggers = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger'`).all();
  for (const { name } of triggers) {
    if (name.startsWith(TRIGGER_PREFIX)) db.exec(`DROP TRIGGER IF EXISTS ${quoteIdentifier(name)}`);
  }
}

export function installChangeLog(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${CHANGE_LOG_TABLE} (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      ts     TEXT NOT NULL,
      tbl    TEXT NOT NULL,
      op     TEXT NOT NULL CHECK (op IN ('I','U','D')),
      old_pk TEXT,
      pk     TEXT NOT NULL,
      row    TEXT
    )
  `);
  removeChangeLogTriggers(db);

  for (const table of listDataTables(db)) {
    const columns = columnNames(db, table);
    const keys = primaryKeyColumns(db, table);
    const jsonOf = (ref, cols) => `json_object(${cols.map((c) => `'${c}', ${ref}.${quoteIdentifier(c)}`).join(", ")})`;
    const insertEntry = (op, oldPk, pk, row) =>
      `INSERT INTO ${CHANGE_LOG_TABLE} (ts, tbl, op, old_pk, pk, row)
       VALUES (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), '${table}', '${op}', ${oldPk}, ${pk}, ${row});`;
    const t = quoteIdentifier(table);
    const changed = columns.map((c) => `OLD.${quoteIdentifier(c)} IS NOT NEW.${quoteIdentifier(c)}`).join(" OR ");

    db.exec(`CREATE TRIGGER ${quoteIdentifier(triggerName(table, "ai"))} AFTER INSERT ON ${t} BEGIN
      ${insertEntry("I", "NULL", jsonOf("NEW", keys), jsonOf("NEW", columns))} END`);
    db.exec(`CREATE TRIGGER ${quoteIdentifier(triggerName(table, "au"))} AFTER UPDATE ON ${t} WHEN ${changed} BEGIN
      ${insertEntry("U", jsonOf("OLD", keys), jsonOf("NEW", keys), jsonOf("NEW", columns))} END`);
    db.exec(`CREATE TRIGGER ${quoteIdentifier(triggerName(table, "ad"))} AFTER DELETE ON ${t} BEGIN
      ${insertEntry("D", "NULL", jsonOf("OLD", keys), "NULL")} END`);
  }
}

export function maxLogId(db) {
  return db.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM ${CHANGE_LOG_TABLE}`).get().id;
}

export function readLogTail(db, afterId) {
  return db.prepare(`SELECT * FROM ${CHANGE_LOG_TABLE} WHERE id > ? ORDER BY id`).all(afterId);
}

// Fingerprint of log entries 1..upToId — equal fingerprints mean two
// databases agree on that entire stretch of history.
export function logDigest(db, upToId) {
  const rows = db.prepare(`SELECT * FROM ${CHANGE_LOG_TABLE} WHERE id <= ? ORDER BY id`).all(upToId);
  return crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}
