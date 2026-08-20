// Handlers for the "orkus-info" database — reminders and calendar events.
// Registered into src/features/db/registry.js by src/features/db/command.js.
// Each function here takes the raw args array following the record type
// (e.g. for ".a db add reminder 2026-08-25T15:00 buy milk", add() receives
// ["reminder", "2026-08-25T15:00", "buy", "milk"]) plus the calling ctx
// (for ctx.userId — who's making the request), and returns a reply
// string — never throws for user-facing input errors, just returns a
// usage message instead.
//
// Reminders are addressed by display_number (a small, reused number —
// see db.js's getNextDisplayNumber()), not the internal `id` (permanent,
// never reused, never shown to users — that's what the scheduler/events
// still use `id` for, unaffected by any of this). Events aren't affected
// either — only reminders tend to accumulate/churn enough for a large
// growing number to actually matter.

import { PermissionsBitField } from "discord.js";
import db, { getNextDisplayNumber } from "./db.js";
import { getClient } from "../../common/discordClient.js";
import { parseIct, fmtIct } from "./format.js";

// Same-ish record within an hour of each other counts as a likely
// duplicate — narrow enough that two genuinely different reminders/events
// an hour apart don't collide, wide enough to catch "did I already add
// this" re-entry.
const DEDUP_WINDOW_MS = 60 * 60 * 1000;

function normalize(text) {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

// Pulls trailing modifier tokens (any order) off the end of an args list:
// "force" (skip the duplicate check) and/or a bare Discord snowflake
// (channel to post the reminder in, instead of DMing the creator).
// Stops at the first token that's neither, so reminder text itself never
// gets mistaken for a modifier.
function stripTrailingModifiers(args) {
  const rest = [...args];
  let force = false;
  let channelId = null;

  while (rest.length > 0) {
    const last = rest[rest.length - 1];
    if (last.toLowerCase() === "force") {
      force = true;
      rest.pop();
    } else if (/^\d{15,20}$/.test(last)) {
      channelId = last;
      rest.pop();
    } else {
      break;
    }
  }
  return { rest, force, channelId };
}

// Checked before ever adding a reminder targeting a channel — per the
// spec, a bad channel should reject the whole add ("ask to try again"),
// not add it and hope for the best when it fires later.
async function canSendInChannel(client, channel) {
  if (!channel || typeof channel.isTextBased !== "function" || !channel.isTextBased()) return false;
  if (channel.guild) {
    const perms = channel.permissionsFor(client.user);
    return Boolean(perms?.has(PermissionsBitField.Flags.SendMessages));
  }
  return true; // DM/group channels: fetch succeeding is good enough
}

// ---------- reminders ----------

// The actual insert logic (channel check, dedup, INSERT), decoupled from
// chat-command arg parsing so anything else that already HAS structured
// values — e.g. the voice API (src/features/db/voiceApi.js), which
// receives JSON, not a token array — can call this directly instead of
// faking a fresh set of chat tokens just to go through addReminder().
export async function addReminderRecord({ text, remindAt, channelId = null, createdBy, force = false }) {
  if (channelId) {
    const client = getClient();
    let channel;
    try {
      channel = await client.channels.fetch(channelId);
    } catch {
      channel = null;
    }
    if (!(await canSendInChannel(client, channel))) {
      return `Can't send in channel \`${channelId}\` — check the ID and that Alani has permission to post there, then try again.`;
    }
  }

  const normalized = normalize(text);
  const windowStart = new Date(remindAt.getTime() - DEDUP_WINDOW_MS).toISOString();
  const windowEnd = new Date(remindAt.getTime() + DEDUP_WINDOW_MS).toISOString();
  const dupe = db
    .prepare(
      `SELECT display_number, text, remind_at FROM reminders WHERE text_normalized = ? AND remind_at BETWEEN ? AND ?`
    )
    .get(normalized, windowStart, windowEnd);

  if (dupe && !force) {
    return `Already have a similar reminder — #${dupe.display_number} "${dupe.text}" at ${fmtIct(dupe.remind_at)} — not adding a duplicate. Add \`force\` at the end to add it anyway.`;
  }

  const displayNumber = getNextDisplayNumber();
  db.prepare(
    `INSERT INTO reminders (text, text_normalized, remind_at, created_at, created_by, channel_id, display_number) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(text, normalized, remindAt.toISOString(), new Date().toISOString(), createdBy, channelId, displayNumber);

  const destination = channelId ? `will post in <#${channelId}>` : "will DM you";
  return `Added reminder #${displayNumber}: "${text}" at ${fmtIct(remindAt.toISOString())} (${destination})`;
}

async function addReminder(args, ctx) {
  const { rest, force, channelId } = stripTrailingModifiers(args);
  const [when, ...textParts] = rest;
  const text = textParts.join(" ").trim();
  const remindAt = parseIct(when);
  if (!remindAt || !text) {
    return "Usage: `.a db add reminder <YYYY-MM-DDTHH:MM> <text> [channel-id] [force]` (24hr time, Indochina/Bangkok timezone)";
  }
  return addReminderRecord({ text, remindAt, channelId, createdBy: ctx.userId, force });
}

function listReminders() {
  const rows = db
    .prepare(`SELECT display_number, text, remind_at, channel_id FROM reminders ORDER BY remind_at ASC`)
    .all();
  if (rows.length === 0) return "No reminders.";
  return rows
    .map(
      (r) =>
        `#${r.display_number} — ${fmtIct(r.remind_at)} — ${r.text} (${r.channel_id ? `<#${r.channel_id}>` : "DM"})`
    )
    .join("\n");
}

// "all" deletes every active reminder — its own path (not just "id ==
// 'all'" on the normal one) since it doesn't reference a display_number
// at all.
function deleteReminder(displayNumber) {
  if (!displayNumber) return "Usage: `.a db delete reminder <id|all>`";
  if (displayNumber.toLowerCase() === "all") {
    const result = db.prepare(`DELETE FROM reminders`).run();
    return result.changes > 0 ? `Deleted all ${result.changes} reminder(s).` : "No reminders to delete.";
  }
  const result = db.prepare(`DELETE FROM reminders WHERE display_number = ?`).run(Number(displayNumber));
  return result.changes > 0 ? `Deleted reminder #${displayNumber}.` : `No reminder #${displayNumber}.`;
}

function editReminder(args) {
  const [displayNumber, when, ...textParts] = args;
  const text = textParts.join(" ").trim();
  const remindAt = parseIct(when);
  if (!displayNumber || !remindAt || !text) {
    return "Usage: `.a db edit reminder <id> <YYYY-MM-DDTHH:MM> <text>` (replaces both fields; destination/channel unchanged — delete and re-add to change that)";
  }
  const result = db
    .prepare(`UPDATE reminders SET text = ?, text_normalized = ?, remind_at = ? WHERE display_number = ?`)
    .run(text, normalize(text), remindAt.toISOString(), Number(displayNumber));
  return result.changes > 0
    ? `Updated reminder #${displayNumber}: "${text}" at ${fmtIct(remindAt.toISOString())}`
    : `No reminder #${displayNumber}.`;
}

// ---------- events ----------

function addEvent(args) {
  const { rest, force } = stripTrailingModifiers(args);
  const [start, end, ...titleParts] = rest;
  const title = titleParts.join(" ").trim();
  const startTime = parseIct(start);
  const endTime = parseIct(end);
  if (!startTime || !endTime || !title || endTime <= startTime) {
    return "Usage: `.a db add event <start> <end> <title>` (24hr time, Indochina/Bangkok timezone, e.g. 2026-08-25T15:00; end must be after start; add `force` at the end to skip the duplicate check)";
  }

  const normalized = normalize(title);
  const windowStart = new Date(startTime.getTime() - DEDUP_WINDOW_MS).toISOString();
  const windowEnd = new Date(startTime.getTime() + DEDUP_WINDOW_MS).toISOString();
  const dupe = db
    .prepare(`SELECT id, title, start_time FROM events WHERE title_normalized = ? AND start_time BETWEEN ? AND ?`)
    .get(normalized, windowStart, windowEnd);

  if (dupe && !force) {
    return `Already have a similar event — #${dupe.id} "${dupe.title}" at ${fmtIct(dupe.start_time)} — not adding a duplicate. Add \`force\` at the end to add it anyway.`;
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

  let reply = `Added event #${info.lastInsertRowid}: "${title}" from ${fmtIct(startTime.toISOString())} to ${fmtIct(endTime.toISOString())}`;
  if (overlaps.length > 0) {
    const list = overlaps.map((e) => `"${e.title}" (${fmtIct(e.start_time)} - ${fmtIct(e.end_time)})`).join(", ");
    reply += `\n⚠️ Overlaps with: ${list}`;
  }
  return reply;
}

function listEvents() {
  const rows = db.prepare(`SELECT id, title, start_time, end_time FROM events ORDER BY start_time ASC`).all();
  if (rows.length === 0) return "No events.";
  return rows.map((e) => `#${e.id} — ${fmtIct(e.start_time)} to ${fmtIct(e.end_time)} — ${e.title}`).join("\n");
}

function deleteEvent(id) {
  if (!id) return "Usage: `.a db delete event <id>`";
  const result = db.prepare(`DELETE FROM events WHERE id = ?`).run(Number(id));
  return result.changes > 0 ? `Deleted event #${id}.` : `No event #${id}.`;
}

function editEvent(args) {
  const [id, start, end, ...titleParts] = args;
  const title = titleParts.join(" ").trim();
  const startTime = parseIct(start);
  const endTime = parseIct(end);
  if (!id || !startTime || !endTime || !title || endTime <= startTime) {
    return "Usage: `.a db edit event <id> <start> <end> <title>` (replaces all fields, 24hr time, Indochina/Bangkok timezone)";
  }
  const result = db
    .prepare(`UPDATE events SET title = ?, title_normalized = ?, start_time = ?, end_time = ? WHERE id = ?`)
    .run(title, normalize(title), startTime.toISOString(), endTime.toISOString(), Number(id));
  return result.changes > 0
    ? `Updated event #${id}: "${title}" from ${fmtIct(startTime.toISOString())} to ${fmtIct(endTime.toISOString())}`
    : `No event #${id}.`;
}

// ---------- registry interface — each dispatches on the record type
// (reminder/event) as its first argument ----------

async function add(args, ctx) {
  const [type, ...rest] = args;
  if (type?.toLowerCase() === "reminder") return addReminder(rest, ctx);
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
