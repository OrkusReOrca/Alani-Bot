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

import db, { getNextDisplayNumber } from "./db.js";
import { getClient } from "../../common/discordClient.js";
import { canSendInChannel } from "../../common/channelAccess.js";
import { extractQuoted, normalizeText, stripTrailingModifiers } from "../../common/textParsing.js";
import { DEDUP_WINDOW_MS, DEFAULT_EVENT_DURATION_MS } from "../../common/recordRules.js";
import { resolveMentions, formatMentions } from "../../common/mentions.js";
import { parseIct, fmtIct, fmtIctDate, ictDateString, startOfIctDay } from "./format.js";
import { config } from "./config.js";
import * as googleCalendar from "../../common/googleCalendar.js";
import { announceDatabaseUpdated } from "../../common/dbAnnouncements.js";

const DATABASE_NAME = "orkus-info";
const announce = (change, itemName, userId) => announceDatabaseUpdated({ name: DATABASE_NAME, change, itemName, userId });


// ---------- reminders ----------

// The actual insert logic (channel check, dedup, INSERT), decoupled from
// chat-command arg parsing so anything else that already HAS structured
// values — e.g. the voice API (src/features/db/voiceApi.js), which
// receives JSON, not a token array — can call this directly instead of
// faking a fresh set of chat tokens just to go through addReminder().
export async function addReminderRecord({ text, remindAt, channelId = null, createdBy, force = false, mentionIds = [] }) {
  let guildIdForMentions = null;
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
    guildIdForMentions = channel?.guildId ?? null;
  }

  const normalized = normalizeText(text);
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
    `INSERT INTO reminders (text, text_normalized, remind_at, created_at, created_by, channel_id, display_number, mentions) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    text,
    normalized,
    remindAt.toISOString(),
    new Date().toISOString(),
    createdBy,
    channelId,
    displayNumber,
    mentionIds.length > 0 ? mentionIds.join(",") : null
  );
  announce("new reminder", text, createdBy);

  const destination = channelId ? `will post in <#${channelId}>` : "will DM you";
  const mentionNote = mentionIds.length > 0 ? `, will also tag ${formatMentions(mentionIds)}` : "";
  return `Added reminder #${displayNumber}: "${text}" at ${fmtIct(remindAt.toISOString())} (${destination}${mentionNote})`;
}

// Reminder "name" field is quoted (`"..."`) so it can safely contain
// spaces, commas, emoji — anything — without colliding with the trailing
// modifiers after it. See common/textParsing.js's extractQuoted() for why
// (bot.js's own tokenizer has no quote-awareness, splitting purely on
// whitespace before any of this code sees it).
const ADD_REMINDER_USAGE =
  'Usage: `.a db add reminder <YYYY-MM-DDTHH:MM> "<text>" [mentions] [channel-id] [force]` (24hr time, Indochina/Bangkok timezone; mentions is a comma-separated list of user IDs and/or usernames, tagged when the reminder fires)';

async function addReminder(args, ctx) {
  const [when, ...afterWhen] = args;
  const remindAt = parseIct(when);
  const quoted = extractQuoted(afterWhen);
  if (!remindAt || !quoted || !quoted.text.trim()) return ADD_REMINDER_USAGE;

  const text = quoted.text.trim();
  const { force, channelId, mentions } = stripTrailingModifiers(quoted.after, { allowMentions: true });

  let mentionIds = [];
  if (mentions) {
    // Same guild the channel-id destination belongs to, if one was
    // given; otherwise fall back to wherever the command-box channel
    // lives — Main tier always operates through that one fixed channel,
    // so it's the closest thing this tier has to a "home guild".
    let guildId = null;
    if (channelId) {
      try {
        guildId = (await getClient().channels.fetch(channelId))?.guildId ?? null;
      } catch {
        guildId = null;
      }
    } else if (config.commandBoxChannelId) {
      try {
        guildId = (await getClient().channels.fetch(config.commandBoxChannelId))?.guildId ?? null;
      } catch {
        guildId = null;
      }
    }
    const { resolved, unresolved } = await resolveMentions(mentions, guildId);
    if (unresolved.length > 0) {
      return `Couldn't resolve ${unresolved.map((u) => `"${u}"`).join(", ")} to a Discord user${guildId ? "" : " (no server context available to search by username — try their user ID instead)"} — fix and try again.`;
    }
    mentionIds = resolved;
  }

  return addReminderRecord({ text, remindAt, channelId, createdBy: ctx.userId, force, mentionIds });
}

function listReminders() {
  const rows = db
    .prepare(`SELECT display_number, text, remind_at, channel_id, mentions FROM reminders ORDER BY remind_at ASC`)
    .all();
  if (rows.length === 0) return "No reminders.";
  return rows
    .map((r) => {
      const mentionNote = r.mentions ? `, tags ${formatMentions(r.mentions.split(","))}` : "";
      return `#${r.display_number} — ${fmtIct(r.remind_at)} — ${r.text} (${r.channel_id ? `<#${r.channel_id}>` : "DM"}${mentionNote})`;
    })
    .join("\n");
}

// "all" deletes every active reminder — its own path (not just "id ==
// 'all'" on the normal one) since it doesn't reference a display_number
// at all.
function deleteReminder(displayNumber, ctx) {
  if (!displayNumber) return "Usage: `.a db delete reminder <id|all>`";
  if (displayNumber.toLowerCase() === "all") {
    const result = db.prepare(`DELETE FROM reminders`).run();
    if (result.changes === 0) return "No reminders to delete.";
    announce("deleted reminders", `all ${result.changes}`, ctx?.userId);
    return `Deleted all ${result.changes} reminder(s).`;
  }
  const existing = db.prepare(`SELECT text FROM reminders WHERE display_number = ?`).get(Number(displayNumber));
  if (!existing) return `No reminder #${displayNumber}.`;
  db.prepare(`DELETE FROM reminders WHERE display_number = ?`).run(Number(displayNumber));
  announce("deleted reminder", existing.text, ctx?.userId);
  return `Deleted reminder #${displayNumber}.`;
}

function editReminder(args, ctx) {
  const quoted = extractQuoted(args);
  const [displayNumber, when] = quoted?.before ?? [];
  const text = quoted?.text.trim();
  const remindAt = parseIct(when);
  if (!displayNumber || !remindAt || !text) {
    return 'Usage: `.a db edit reminder <id> <YYYY-MM-DDTHH:MM> "<text>"` (replaces both fields; destination/channel/mentions unchanged — delete and re-add to change those)';
  }
  const result = db
    .prepare(`UPDATE reminders SET text = ?, text_normalized = ?, remind_at = ? WHERE display_number = ?`)
    .run(text, normalizeText(text), remindAt.toISOString(), Number(displayNumber));
  if (result.changes === 0) return `No reminder #${displayNumber}.`;
  announce("edited reminder", text, ctx?.userId);
  return `Updated reminder #${displayNumber}: "${text}" at ${fmtIct(remindAt.toISOString())}`;
}

// ---------- events ----------
//
// Every write (add/edit/delete) also mirrors to Google Calendar
// (config.googleCalendarId — orkus-info's own, per-database setting) —
// one-way, this database stays the source of truth. Best-effort: a
// Google API failure is logged, never blocks or rolls back the local
// write that already succeeded. googleCalendar.js's functions already
// no-op (return null/undefined) if the sync isn't configured at all, so
// none of this needs its own "is this set up" branching here.

const ADD_EVENT_USAGE =
  'Usage: `.a db add event <start> [end|allday] "<title>" [force]` (24hr time, Indochina/Bangkok timezone, e.g. 2026-08-25T15:00 — year/month optional, assumes current; end defaults to 1 hour after start if omitted; use `allday` in place of end for an all-day event; add `force` at the end to skip the duplicate check)';

async function addEvent(args, ctx) {
  const quoted = extractQuoted(args);
  if (!quoted) return ADD_EVENT_USAGE;
  const force = quoted.after.some((t) => t.toLowerCase() === "force");
  const [startRaw, second] = quoted.before;
  const parsedStart = parseIct(startRaw);
  if (!parsedStart) return ADD_EVENT_USAGE;

  // The title is already unambiguously delimited by quotes now, so
  // `second` (whatever's between start and the opening quote) can only
  // ever be the optional end/allday token — no more guessing whether it
  // was actually the first word of an unquoted title.
  let startTime = parsedStart;
  let endTime;
  let allDay = false;

  if (second?.toLowerCase() === "allday") {
    allDay = true;
    startTime = startOfIctDay(parsedStart);
    endTime = new Date(startTime.getTime() + 24 * 60 * 60 * 1000);
  } else if (second) {
    const parsedEnd = parseIct(second);
    if (!parsedEnd) return ADD_EVENT_USAGE;
    endTime = parsedEnd;
  } else {
    endTime = new Date(parsedStart.getTime() + DEFAULT_EVENT_DURATION_MS);
  }

  const title = quoted.text.trim();
  if (!title || endTime <= startTime) return ADD_EVENT_USAGE;

  const normalized = normalizeText(title);
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
    .prepare(
      `INSERT INTO events (title, title_normalized, start_time, end_time, created_at, all_day) VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(title, normalized, startTime.toISOString(), endTime.toISOString(), new Date().toISOString(), allDay ? 1 : 0);
  announce("new event", title, ctx?.userId);

  try {
    const googleEventId = await googleCalendar.createEvent(config.googleCalendarId, {
      summary: title,
      start: allDay ? ictDateString(startTime) : startTime,
      end: allDay ? ictDateString(endTime) : endTime,
      allDay,
    });
    if (googleEventId) {
      db.prepare(`UPDATE events SET google_event_id = ? WHERE id = ?`).run(googleEventId, info.lastInsertRowid);
    }
  } catch (err) {
    console.error("[orkus-info] failed to sync new event to Google Calendar:", err);
  }

  const whenText = allDay
    ? `all day ${fmtIctDate(startTime.toISOString())}`
    : `from ${fmtIct(startTime.toISOString())} to ${fmtIct(endTime.toISOString())}`;
  let reply = `Added event #${info.lastInsertRowid}: "${title}" ${whenText}`;
  if (overlaps.length > 0) {
    const list = overlaps.map((e) => `"${e.title}" (${fmtIct(e.start_time)} - ${fmtIct(e.end_time)})`).join(", ");
    reply += `\n⚠️ Overlaps with: ${list}`;
  }
  return reply;
}

function listEvents() {
  const rows = db.prepare(`SELECT id, title, start_time, end_time, all_day FROM events ORDER BY start_time ASC`).all();
  if (rows.length === 0) return "No events.";
  return rows
    .map((e) =>
      e.all_day
        ? `#${e.id} — ${fmtIctDate(e.start_time)} (all day) — ${e.title}`
        : `#${e.id} — ${fmtIct(e.start_time)} to ${fmtIct(e.end_time)} — ${e.title}`
    )
    .join("\n");
}

async function deleteEvent(id, ctx) {
  if (!id) return "Usage: `.a db delete event <id>`";
  const row = db.prepare(`SELECT title, google_event_id FROM events WHERE id = ?`).get(Number(id));
  if (!row) return `No event #${id}.`;
  db.prepare(`DELETE FROM events WHERE id = ?`).run(Number(id));
  announce("deleted event", row.title, ctx?.userId);

  if (row.google_event_id) {
    try {
      await googleCalendar.deleteEvent(config.googleCalendarId, row.google_event_id);
    } catch (err) {
      console.error("[orkus-info] failed to delete event from Google Calendar:", err);
    }
  }

  return `Deleted event #${id}.`;
}

async function editEvent(args, ctx) {
  const quoted = extractQuoted(args);
  const [id, start, end] = quoted?.before ?? [];
  const title = quoted?.text.trim();
  const startTime = parseIct(start);
  const endTime = parseIct(end);
  if (!id || !startTime || !endTime || !title || endTime <= startTime) {
    return 'Usage: `.a db edit event <id> <start> <end> "<title>"` (replaces all fields, 24hr time, Indochina/Bangkok timezone)';
  }

  const existing = db.prepare(`SELECT google_event_id FROM events WHERE id = ?`).get(Number(id));
  // edit doesn't support the allday shorthand (yet — add does) — an
  // explicit start+end here always means "this is a timed event now",
  // so all_day is reset even if it was previously an all-day event,
  // rather than leaving a stale all_day=1 next to real timed values.
  const result = db
    .prepare(`UPDATE events SET title = ?, title_normalized = ?, start_time = ?, end_time = ?, all_day = 0 WHERE id = ?`)
    .run(title, normalizeText(title), startTime.toISOString(), endTime.toISOString(), Number(id));

  if (result.changes === 0) return `No event #${id}.`;
  announce("edited event", title, ctx?.userId);

  if (existing?.google_event_id) {
    try {
      await googleCalendar.updateEvent(config.googleCalendarId, existing.google_event_id, {
        summary: title,
        start: startTime,
        end: endTime,
      });
    } catch (err) {
      console.error("[orkus-info] failed to update event on Google Calendar:", err);
    }
  }

  return `Updated event #${id}: "${title}" from ${fmtIct(startTime.toISOString())} to ${fmtIct(endTime.toISOString())}`;
}

// ---------- registry interface — each dispatches on the record type
// (reminder/event) as its first argument ----------

async function add(args, ctx) {
  const [type, ...rest] = args;
  if (type?.toLowerCase() === "reminder") return addReminder(rest, ctx);
  if (type?.toLowerCase() === "event") return addEvent(rest, ctx);
  return "Usage: `.a db add <reminder|event> ...`";
}

async function list(args) {
  const [type] = args;
  const t = type?.toLowerCase();
  if (t === "reminder" || t === "reminders") return listReminders();
  if (t === "event" || t === "events") return listEvents();
  return "Usage: `.a db list <reminders|events>`";
}

async function del(args, ctx) {
  const [type, id] = args;
  const t = type?.toLowerCase();
  if (t === "reminder") return deleteReminder(id, ctx);
  if (t === "event") return deleteEvent(id, ctx);
  return "Usage: `.a db delete <reminder|event> <id>`";
}

async function edit(args, ctx) {
  const [type, ...rest] = args;
  if (type?.toLowerCase() === "reminder") return editReminder(rest, ctx);
  if (type?.toLowerCase() === "event") return editEvent(rest, ctx);
  return "Usage: `.a db edit <reminder|event> <id> ...`";
}

export default { add, list, delete: del, edit };
