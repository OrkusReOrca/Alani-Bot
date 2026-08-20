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

// display_number: the small, user-facing number reminders are actually
// added/edited/deleted by — separate from `id` (the real primary key,
// permanent, never reused, never shown to users). display_number IS
// reused once its holder is deleted: the smallest positive integer not
// currently used by any existing reminder (see getNextDisplayNumber()).
// With <=20 reminders active this naturally stays packed into 1-20 and
// keeps recycling; it only grows past 20 once all of 1-20 are genuinely
// in use at once, and shrinks back down as soon as gaps open up again —
// no separate "current range" bookkeeping needed, this falls out of
// "always take the smallest free number" on its own.
ensureColumn("reminders", "display_number", "INTEGER");

// One-time backfill for rows that predate this column (display_number
// comes back NULL for those otherwise, making them unaddressable by the
// new scheme) — assigns each the next available number in `id` order,
// same rule new reminders get.
{
  const unbackfilled = db.prepare(`SELECT id FROM reminders WHERE display_number IS NULL ORDER BY id`).all();
  if (unbackfilled.length > 0) {
    const used = new Set(
      db
        .prepare(`SELECT display_number FROM reminders WHERE display_number IS NOT NULL`)
        .all()
        .map((r) => r.display_number)
    );
    let next = 1;
    for (const row of unbackfilled) {
      while (used.has(next)) next++;
      db.prepare(`UPDATE reminders SET display_number = ? WHERE id = ?`).run(next, row.id);
      used.add(next);
    }
  }
}

// google_event_id: the matching Google Calendar event's own ID, once
// synced there — null until/unless the Google sync is configured (see
// config.js's googleCalendarId and common/googleCalendar.js). Needed so
// edits/deletes can find and update/remove the right Google-side event,
// not just add new ones there.
ensureColumn("events", "google_event_id", "TEXT");

// Smallest positive integer not currently used by any existing reminder.
export function getNextDisplayNumber() {
  const used = new Set(
    db
      .prepare(`SELECT display_number FROM reminders WHERE display_number IS NOT NULL`)
      .all()
      .map((r) => r.display_number)
  );
  let n = 1;
  while (used.has(n)) n++;
  return n;
}

export default db;
