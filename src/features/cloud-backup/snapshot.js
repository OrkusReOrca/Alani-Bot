// SQLite snapshot operations the backup runs on: take a consistent copy of
// a live database, fingerprint its data, replay change-log entries onto a
// copy, diff two databases, and restore a snapshot into a live connection.

import crypto from "crypto";
import fs from "fs";
import { DatabaseSync } from "node:sqlite";
import {
  CHANGE_LOG_TABLE,
  listDataTables,
  columnNames,
  primaryKeyColumns,
  installChangeLog,
  removeChangeLogTriggers,
} from "./changeLog.js";

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function openDatabase(path) {
  return new DatabaseSync(path);
}

// A transactionally-consistent, compacted copy of a live database, safe to
// take while the bot keeps writing to it.
export function snapshotTo(db, destPath) {
  fs.rmSync(destPath, { force: true });
  db.exec(`VACUUM INTO ${sqlString(destPath)}`);
}

// ---------- reading data ----------

function orderedRows(db, table) {
  const keys = primaryKeyColumns(db, table).map((k) => `"${k}"`).join(", ");
  return db.prepare(`SELECT * FROM "${table}" ORDER BY ${keys}`).all();
}

// Every data table's rows, keyed by table name. The change log is excluded:
// it describes the data, it isn't part of it.
export function readData(db) {
  return new Map(listDataTables(db).map((table) => [table, orderedRows(db, table)]));
}

export function dataDigest(db) {
  return crypto.createHash("sha256").update(JSON.stringify([...readData(db)])).digest("hex");
}

// ---------- replaying the log ----------

// Makes `target`'s tables/columns cover everything `reference` has, so log
// entries written against a newer schema can be replayed onto an older
// snapshot. Mirrors what ensureColumn() does to the live database at
// startup, including column defaults.
export function alignSchema(target, reference) {
  const existing = new Set(listDataTables(target));
  for (const table of listDataTables(reference)) {
    if (!existing.has(table)) {
      const { sql } = reference.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table);
      target.exec(sql);
      continue;
    }
    const have = new Set(columnNames(target, table));
    for (const col of reference.prepare(`PRAGMA table_info("${table}")`).all()) {
      if (have.has(col.name)) continue;
      const dflt = col.dflt_value === null ? "" : ` DEFAULT ${col.dflt_value}`;
      target.exec(`ALTER TABLE "${table}" ADD COLUMN "${col.name}" ${col.type}${dflt}`);
    }
  }
}

function deleteByKey(db, table, pk) {
  const keys = primaryKeyColumns(db, table);
  db.prepare(`DELETE FROM "${table}" WHERE ${keys.map((k) => `"${k}" IS ?`).join(" AND ")}`).run(...keys.map((k) => pk[k]));
}

// Applies log entries, in order, to `db` (a plain snapshot copy — it has no
// triggers of its own that could re-log them).
export function replayLog(db, entries) {
  for (const entry of entries) {
    if (entry.op === "D") {
      deleteByKey(db, entry.tbl, JSON.parse(entry.pk));
      continue;
    }
    if (entry.op === "U" && entry.old_pk !== entry.pk) deleteByKey(db, entry.tbl, JSON.parse(entry.old_pk));
    const row = JSON.parse(entry.row);
    const cols = Object.keys(row);
    db.prepare(
      `INSERT OR REPLACE INTO "${entry.tbl}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`
    ).run(...cols.map((c) => row[c]));
  }
}

// ---------- diffing ----------

const keyOf = (keys, row) => JSON.stringify(keys.map((k) => row[k]));

// Row-level differences between two databases. `a`/`b` on each entry are the
// row as it appears in each side (undefined where the row is absent).
export function diffData(dbA, dbB) {
  const diffs = [];
  const tablesA = new Set(listDataTables(dbA));
  const tablesB = new Set(listDataTables(dbB));
  for (const table of [...new Set([...tablesA, ...tablesB])].sort()) {
    const keys = primaryKeyColumns(tablesA.has(table) ? dbA : dbB, table);
    const rowsA = tablesA.has(table) ? orderedRows(dbA, table) : [];
    const rowsB = tablesB.has(table) ? orderedRows(dbB, table) : [];
    const byKeyB = new Map(rowsB.map((r) => [keyOf(keys, r), r]));
    const seen = new Set();

    for (const a of rowsA) {
      const k = keyOf(keys, a);
      seen.add(k);
      const b = byKeyB.get(k);
      if (!b) {
        diffs.push({ table, key: k, a });
      } else if (JSON.stringify(a) !== JSON.stringify(b)) {
        diffs.push({ table, key: k, a, b });
      }
    }
    for (const b of rowsB) {
      const k = keyOf(keys, b);
      if (!seen.has(k)) diffs.push({ table, key: k, b });
    }
  }
  return diffs;
}

// ---------- restoring ----------

const restoreTables = (db) => [...listDataTables(db), CHANGE_LOG_TABLE];

// Replaces the live connection's data (and change log) with the snapshot's,
// in place — modules keep their existing connection, so nothing needs to be
// reopened. Runs as one transaction; the change-log triggers are removed
// for its duration so the restore itself isn't logged as if a user did it.
// Columns the snapshot lacks (added by a later migration) take their
// defaults.
export function restoreInto(liveDb, snapshotPath) {
  liveDb.exec(`ATTACH DATABASE ${sqlString(snapshotPath)} AS snap`);
  try {
    const snapTables = new Set(
      liveDb.prepare(`SELECT name FROM snap.sqlite_master WHERE type = 'table'`).all().map((r) => r.name)
    );
    liveDb.exec("BEGIN");
    try {
      removeChangeLogTriggers(liveDb);
      for (const table of restoreTables(liveDb)) {
        liveDb.exec(`DELETE FROM main."${table}"`);
        if (!snapTables.has(table)) continue;
        const snapCols = new Set(liveDb.prepare(`PRAGMA snap.table_info("${table}")`).all().map((c) => c.name));
        const shared = columnNames(liveDb, table).filter((c) => snapCols.has(c)).map((c) => `"${c}"`).join(", ");
        liveDb.exec(`INSERT INTO main."${table}" (${shared}) SELECT ${shared} FROM snap."${table}"`);
      }
      // AUTOINCREMENT counters (the change log itself guarantees this table
      // exists), so freshly issued ids continue after the restored ones
      // instead of colliding with them.
      liveDb.exec(`DELETE FROM main.sqlite_sequence`);
      if (snapTables.has("sqlite_sequence")) {
        liveDb.exec(`INSERT INTO main.sqlite_sequence SELECT * FROM snap.sqlite_sequence`);
      }
      liveDb.exec("COMMIT");
    } catch (err) {
      liveDb.exec("ROLLBACK");
      throw err;
    }
  } finally {
    liveDb.exec("DETACH DATABASE snap");
  }
  installChangeLog(liveDb);
}
