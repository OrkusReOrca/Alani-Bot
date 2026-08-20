// SQLite connection + schema for the "orkus-info" database — reminders
// and calendar events for now, more tables (email, etc.) later.
//
// Uses node:sqlite (built into Node itself, stable since Node 22.5+ —
// this repo runs Node 22+ in CI and the bot host runs 24.x) instead of an
// npm package like better-sqlite3, deliberately: that's a native module
// too, and this repo already got burned once by a native module (canvas)
// whose install script got blocked by bot-hosting.net's default script
// policy, crashing the whole persistent bot on startup. node:sqlite needs
// no native build step at all, so that whole class of risk doesn't apply
// here.
//
// The .db file itself lives on the bot's own persistent host storage, NOT
// committed to git (see .gitignore) — unlike the JSON state files
// elsewhere in this repo, this changes on every command and doesn't
// benefit from git history.

import { DatabaseSync } from "node:sqlite";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "..", "..", "data", "orkus-info");
const DB_PATH = path.join(DATA_DIR, "orkus-info.db");

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    text_normalized TEXT NOT NULL,
    remind_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    title_normalized TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

// Migration for columns added after the initial release — guarded by a
// column-existence check (unlike a bare ALTER TABLE ADD COLUMN, which
// errors if run a second time) so this stays safe to run on every
// startup, including against a database that already has rows from
// before these columns existed (they just come back NULL for those).
function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

// created_by: who to DM by default when the reminder fires (and whose
// username to show if it posts to a channel instead). channel_id: if
// set, post there instead of DMing created_by. See scheduler.js.
ensureColumn("reminders", "created_by", "TEXT");
ensureColumn("reminders", "channel_id", "TEXT");

export default db;
