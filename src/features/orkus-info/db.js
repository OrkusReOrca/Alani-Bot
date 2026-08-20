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

export default db;
