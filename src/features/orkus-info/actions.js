// Handlers for the "orkus-info" database — reminders and calendar events.
// Registered into src/features/db/registry.js by src/features/db/command.js.
// Each function here takes the raw args array following the record type
// (e.g. for ".a db add reminder 2026-08-25T15:00 buy milk", add() receives
// ["reminder", "2026-08-25T15:00", "buy", "milk"]) and returns a reply
// string — never throws for user-facing input errors, just returns a
// usage message instead.

import db from "./db.js";

// Same-ish record within an hour of each other counts as a likely
// duplicate — narrow enough that two genuinely different reminders/events
// an hour apart don't collide, wide enough to catch "did I already add
// this" re-entry.
const DEDUP_WINDOW_MS = 60 * 60 * 1000;

function normalize(text) {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function fmt(isoString) {
  return new Date(isoString).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function isForce(args) {
  return args.length > 0 && args[args.length - 1]?.toLowerCase() === "force";
}

function stripForce(args) {
  return isForce(args) ? args.slice(0, -1) : args;
}

// ---------- reminders ----------

function addReminder(args) {
  const force = isForce(args);
  const [when, ...textParts] = stripForce(args);
  const text = textParts.join(" ").trim();
  const remindAt = parseDate(when);
  if (!remindAt || !text) {
    return "Usage: `.a db add reminder <YYYY-MM-DDTHH:MM> <text>` (add `force` at the end to skip the duplicate check)";
  }

  const normalized = normalize(text);
  const windowStart = new Date(remindAt.getTime() - DEDUP_WINDOW_MS).toISOString();
  const windowEnd = new Date(remindAt.getTime() + DEDUP_WINDOW_MS).toISOString();
  const dupe = db
    .prepare(`SELECT id, text, remind_at FROM reminders WHERE text_normalized = ? AND remind_at BETWEEN ? AND ?`)
    .get(normalized, windowStart, windowEnd);

  if (dupe && !force) {
    return `Already have a similar reminder — #${dupe.id} "${dupe.text}" at ${fmt(dupe.remind_at)} — not adding a duplicate. Add \`force\` at the end to add it anyway.`;
  }

  const info = db
    .prepare(`INSERT INTO reminders (text, text_normalized, remind_at, created_at) VALUES (?, ?, ?, ?)`)
    .run(text, normalized, remindAt.toISOString(), new Date().toISOString());

  return `Added reminder #${info.lastInsertRowid}: "${text}" at ${fmt(remindAt.toISOString())}`;
}

function listReminders() {
  const rows = db.prepare(`SELECT id, text, remind_at FROM reminders ORDER BY remind_at ASC`).all();
  if (rows.length === 0) return "No reminders.";
  return rows.map((r) => `#${r.id} — ${fmt(r.remind_at)} — ${r.text}`).join("\n");
}

function deleteReminder(id) {
  if (!id) return "Usage: `.a db delete reminder <id>`";
  const result = db.prepare(`DELETE FROM reminders WHERE id = ?`).run(Number(id));
  return result.changes > 0 ? `Deleted reminder #${id}.` : `No reminder #${id}.`;
}

function editReminder(args) {
  const [id, when, ...textParts] = args;
  const text = textParts.join(" ").trim();
  const remindAt = parseDate(when);
  if (!id || !remindAt || !text) {
    return "Usage: `.a db edit reminder <id> <YYYY-MM-DDTHH:MM> <text>` (replaces both fields)";
  }
  const result = db
    .prepare(`UPDATE reminders SET text = ?, text_normalized = ?, remind_at = ? WHERE id = ?`)
    .run(text, normalize(text), remindAt.toISOString(), Number(id));
  return result.changes > 0
    ? `Updated reminder #${id}: "${text}" at ${fmt(remindAt.toISOString())}`
    : `No reminder #${id}.`;
}

// ---------- events ----------

function addEvent(args) {
  const force = isForce(args);
  const [start, end, ...titleParts] = stripForce(args);
  const title = titleParts.join(" ").trim();
  const startTime = parseDate(start);
  const endTime = parseDate(end);
  if (!startTime || !endTime || !title || endTime <= startTime) {
    return "Usage: `.a db add event <start> <end> <title>` (ISO datetimes, e.g. 2026-08-25T15:00; end must be after start; add `force` at the end to skip the duplicate check)";
  }

  const normalized = normalize(title);
  const windowStart = new Date(startTime.getTime() - DEDUP_WINDOW_MS).toISOString();
  const windowEnd = new Date(startTime.getTime() + DEDUP_WINDOW_MS).toISOString();
  const dupe = db
    .prepare(`SELECT id, title, start_time FROM events WHERE title_normalized = ? AND start_time BETWEEN ? AND ?`)
    .get(normalized, windowStart, windowEnd);

  if (dupe && !force) {
    return `Already have a similar event — #${dupe.id} "${dupe.title}" at ${fmt(dupe.start_time)} — not adding a duplicate. Add \`force\` at the end to add it anyway.`;
  }

  // Classic interval-overlap query: an existing event conflicts if it
  // starts before this one ends AND ends after this one starts. This is a
  // warning, not a block — overlaps are sometimes intentional.
  const overlaps = db
    .prepare(`SELECT id, title, start_time, end_time FROM events WHERE start_time < ? AND end_time > ?`)
    .all(endTime.toISOString(), startTime.toISOString());

  const info = db
    .prepare(`INSERT INTO events (title, title_normalized, start_time, end_time, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(title, normalized, startTime.toISOString(), endTime.toISOString(), new Date().toISOString());

  let reply = `Added event #${info.lastInsertRowid}: "${title}" from ${fmt(startTime.toISOString())} to ${fmt(endTime.toISOString())}`;
  if (overlaps.length > 0) {
    const list = overlaps.map((e) => `"${e.title}" (${fmt(e.start_time)} - ${fmt(e.end_time)})`).join(", ");
    reply += `\n⚠️ Overlaps with: ${list}`;
  }
  return reply;
}

function listEvents() {
  const rows = db.prepare(`SELECT id, title, start_time, end_time FROM events ORDER BY start_time ASC`).all();
  if (rows.length === 0) return "No events.";
  return rows.map((e) => `#${e.id} — ${fmt(e.start_time)} to ${fmt(e.end_time)} — ${e.title}`).join("\n");
}

function deleteEvent(id) {
  if (!id) return "Usage: `.a db delete event <id>`";
  const result = db.prepare(`DELETE FROM events WHERE id = ?`).run(Number(id));
  return result.changes > 0 ? `Deleted event #${id}.` : `No event #${id}.`;
}

function editEvent(args) {
  const [id, start, end, ...titleParts] = args;
  const title = titleParts.join(" ").trim();
  const startTime = parseDate(start);
  const endTime = parseDate(end);
  if (!id || !startTime || !endTime || !title || endTime <= startTime) {
    return "Usage: `.a db edit event <id> <start> <end> <title>` (replaces all fields, ISO datetimes)";
  }
  const result = db
    .prepare(`UPDATE events SET title = ?, title_normalized = ?, start_time = ?, end_time = ? WHERE id = ?`)
    .run(title, normalize(title), startTime.toISOString(), endTime.toISOString(), Number(id));
  return result.changes > 0
    ? `Updated event #${id}: "${title}" from ${fmt(startTime.toISOString())} to ${fmt(endTime.toISOString())}`
    : `No event #${id}.`;
}

// ---------- registry interface — each dispatches on the record type
// (reminder/event) as its first argument ----------

async function add(args) {
  const [type, ...rest] = args;
  if (type?.toLowerCase() === "reminder") return addReminder(rest);
  if (type?.toLowerCase() === "event") return addEvent(rest);
  return "Usage: `.a db add <reminder|event> ...`";
}

async function list(args) {
  const [type] = args;
  const t = type?.toLowerCase();
  if (t === "reminder" || t === "reminders") return listReminders();
  if (t === "event" || t === "events") return listEvents();
  return "Usage: `.a db list <reminders|events>`";
}

async function del(args) {
  const [type, id] = args;
  const t = type?.toLowerCase();
  if (t === "reminder") return deleteReminder(id);
  if (t === "event") return deleteEvent(id);
  return "Usage: `.a db delete <reminder|event> <id>`";
}

async function edit(args) {
  const [type, ...rest] = args;
  if (type?.toLowerCase() === "reminder") return editReminder(rest);
  if (type?.toLowerCase() === "event") return editEvent(rest);
  return "Usage: `.a db edit <reminder|event> <id> ...`";
}

export default { add, list, delete: del, edit };
