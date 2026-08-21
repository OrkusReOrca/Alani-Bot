// Shared reminder/event CRUD logic for the two new tiered database kinds
// (general-user-db, general-server-db — see src/features/db/store.js for
// their shared gen_reminders/gen_events tables). Deliberately NOT shared
// with orkus-info (the "Main" tier), which keeps its own separate,
// untouched copy of this same shape of logic — see the root README's
// "Tiers" section for why Main was kept fully independent rather than
// refactored to share code with these two. Some duplication of the
// dedup/overlap/display-number pattern against orkus-info/actions.js is
// intentional, accepted for that reason.
//
// createRecordActions() is called fresh per command invocation (not once
// at module load), since which database instance (databaseId) is being
// targeted changes per call — see general-user-db/actions.js and
// general-server-db/actions.js for the call site. The onEventCreate/
// Update/Delete hooks are the one thing that differs between the two
// database kinds: general-user-db passes no-ops (SQLite only, no mirror
// anywhere); general-server-db passes closures that create/update/delete
// a real Discord Scheduled Event (src/common/discordScheduledEvents.js).

import storeDb, { getNextDisplayNumber, logEvent } from "../features/db/store.js";
import { getClient } from "./discordClient.js";
import { canSendInChannel } from "./channelAccess.js";
import { parseIct, fmtIct, fmtIctDate, startOfIctDay } from "../features/orkus-info/format.js";

const DEDUP_WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_EVENT_DURATION_MS = 60 * 60 * 1000;

function normalize(text) {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

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

// Splits an args array on a literal "|" token — everything before is the
// title, everything after (joined back with spaces) is the location.
// Used only by add/edit event; a title genuinely containing "|" isn't
// supported (an edge case accepted for the sake of an unambiguous split).
function splitOnPipe(tokens) {
  const idx = tokens.indexOf("|");
  if (idx === -1) return { main: tokens, location: null };
  return { main: tokens.slice(0, idx), location: tokens.slice(idx + 1).join(" ").trim() || null };
}

export function createRecordActions({ databaseId, databaseName, onEventCreate = async () => ({}), onEventUpdate = async () => {}, onEventDelete = async () => {} }) {
  // ---------- reminders ----------

  async function addReminderRecord({ text, remindAt, channelId = null, createdBy, force = false, ctx = null }) {
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
    const dupe = storeDb
      .prepare(
        `SELECT display_number, text, remind_at FROM gen_reminders WHERE database_id = ? AND text_normalized = ? AND remind_at BETWEEN ? AND ?`
      )
      .get(databaseId, normalized, windowStart, windowEnd);

    if (dupe && !force) {
      return `Already have a similar reminder — #${dupe.display_number} "${dupe.text}" at ${fmtIct(dupe.remind_at)} — not adding a duplicate. Add \`force\` at the end to add it anyway.`;
    }

    const displayNumber = getNextDisplayNumber(databaseId);
    storeDb
      .prepare(
        `INSERT INTO gen_reminders (database_id, text, text_normalized, remind_at, created_at, created_by, channel_id, display_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(databaseId, text, normalized, remindAt.toISOString(), new Date().toISOString(), createdBy, channelId, displayNumber);
    logEvent("reminder_created", createdBy, {
      databaseId,
      detail: { text, remindAt: remindAt.toISOString() },
      channelId: ctx?.channelId ?? null,
      guildId: ctx?.guildId ?? null,
    });

    const destination = channelId ? `will post in <#${channelId}>` : "will DM you";
    return `Added reminder #${displayNumber}: "${text}" at ${fmtIct(remindAt.toISOString())} (${destination})`;
  }

  async function addReminder(args, ctx) {
    const { rest, force, channelId } = stripTrailingModifiers(args);
    const [when, ...textParts] = rest;
    const text = textParts.join(" ").trim();
    const remindAt = parseIct(when);
    if (!remindAt || !text) {
      return "Usage: `.a db [<name>] add reminder <YYYY-MM-DDTHH:MM> <text> [channel-id] [force]` (24hr time, Indochina/Bangkok timezone)";
    }
    return addReminderRecord({ text, remindAt, channelId, createdBy: ctx.userId, force, ctx });
  }

  function listReminders() {
    const rows = storeDb
      .prepare(`SELECT display_number, text, remind_at, channel_id FROM gen_reminders WHERE database_id = ? ORDER BY remind_at ASC`)
      .all(databaseId);
    if (rows.length === 0) return "No reminders.";
    return rows
      .map(
        (r) =>
          `#${r.display_number} — ${fmtIct(r.remind_at)} — ${r.text} (${r.channel_id ? `<#${r.channel_id}>` : "DM"})`
      )
      .join("\n");
  }

  function deleteReminder(displayNumber) {
    if (!displayNumber) return "Usage: `.a db delete reminder <id|all>`";
    if (displayNumber.toLowerCase() === "all") {
      const result = storeDb.prepare(`DELETE FROM gen_reminders WHERE database_id = ?`).run(databaseId);
      return result.changes > 0 ? `Deleted all ${result.changes} reminder(s).` : "No reminders to delete.";
    }
    const result = storeDb
      .prepare(`DELETE FROM gen_reminders WHERE database_id = ? AND display_number = ?`)
      .run(databaseId, Number(displayNumber));
    return result.changes > 0 ? `Deleted reminder #${displayNumber}.` : `No reminder #${displayNumber}.`;
  }

  function editReminder(args) {
    const [displayNumber, when, ...textParts] = args;
    const text = textParts.join(" ").trim();
    const remindAt = parseIct(when);
    if (!displayNumber || !remindAt || !text) {
      return "Usage: `.a db edit reminder <id> <YYYY-MM-DDTHH:MM> <text>` (replaces both fields; destination/channel unchanged — delete and re-add to change that)";
    }
    const result = storeDb
      .prepare(`UPDATE gen_reminders SET text = ?, text_normalized = ?, remind_at = ? WHERE database_id = ? AND display_number = ?`)
      .run(text, normalize(text), remindAt.toISOString(), databaseId, Number(displayNumber));
    return result.changes > 0
      ? `Updated reminder #${displayNumber}: "${text}" at ${fmtIct(remindAt.toISOString())}`
      : `No reminder #${displayNumber}.`;
  }

  // ---------- events ----------

  const ADD_EVENT_USAGE =
    "Usage: `.a db add event <start> [end|allday] <title> [| <location>]` (24hr time, Indochina/Bangkok timezone, e.g. 2026-08-25T15:00 — year/month optional, assumes current; end defaults to 1 hour after start if omitted; use `allday` in place of end for an all-day event; add `force` at the end to skip the duplicate check; `| <location>` is optional, defaults to this database's name)";

  async function addEvent(args, ctx = null) {
    const { rest, force } = stripTrailingModifiers(args);
    const { main, location: pipedLocation } = splitOnPipe(rest);
    const [startRaw, second, ...others] = main;
    const parsedStart = parseIct(startRaw);
    if (!parsedStart) return ADD_EVENT_USAGE;

    let startTime = parsedStart;
    let endTime;
    let allDay = false;
    let titleParts;

    if (second?.toLowerCase() === "allday") {
      allDay = true;
      startTime = startOfIctDay(parsedStart);
      endTime = new Date(startTime.getTime() + 24 * 60 * 60 * 1000);
      titleParts = others;
    } else {
      const parsedEnd = second ? parseIct(second) : null;
      if (parsedEnd) {
        endTime = parsedEnd;
        titleParts = others;
      } else {
        endTime = new Date(parsedStart.getTime() + DEFAULT_EVENT_DURATION_MS);
        titleParts = second !== undefined ? [second, ...others] : others;
      }
    }

    const title = titleParts.join(" ").trim();
    if (!title || endTime <= startTime) return ADD_EVENT_USAGE;
    const location = pipedLocation ?? databaseName;

    const normalized = normalize(title);
    const windowStart = new Date(startTime.getTime() - DEDUP_WINDOW_MS).toISOString();
    const windowEnd = new Date(startTime.getTime() + DEDUP_WINDOW_MS).toISOString();
    const dupe = storeDb
      .prepare(`SELECT id, title, start_time FROM gen_events WHERE database_id = ? AND title_normalized = ? AND start_time BETWEEN ? AND ?`)
      .get(databaseId, normalized, windowStart, windowEnd);

    if (dupe && !force) {
      return `Already have a similar event — #${dupe.id} "${dupe.title}" at ${fmtIct(dupe.start_time)} — not adding a duplicate. Add \`force\` at the end to add it anyway.`;
    }

    const overlaps = storeDb
      .prepare(`SELECT id, title, start_time, end_time FROM gen_events WHERE database_id = ? AND start_time < ? AND end_time > ?`)
      .all(databaseId, endTime.toISOString(), startTime.toISOString());

    const info = storeDb
      .prepare(
        `INSERT INTO gen_events (database_id, title, title_normalized, start_time, end_time, created_at, all_day, location) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(databaseId, title, normalized, startTime.toISOString(), endTime.toISOString(), new Date().toISOString(), allDay ? 1 : 0, location);
    logEvent("event_created", ctx?.userId ?? "unknown", {
      databaseId,
      detail: { title, start: startTime.toISOString(), end: endTime.toISOString() },
      channelId: ctx?.channelId ?? null,
      guildId: ctx?.guildId ?? null,
    });

    try {
      const { discordEventId } = (await onEventCreate({ title, start: startTime, end: endTime, allDay, location })) ?? {};
      if (discordEventId) {
        storeDb.prepare(`UPDATE gen_events SET discord_event_id = ? WHERE id = ?`).run(discordEventId, info.lastInsertRowid);
      }
    } catch (err) {
      console.error(`[recordActions] failed to mirror new event (db ${databaseId}):`, err);
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
    const rows = storeDb
      .prepare(`SELECT id, title, start_time, end_time, all_day FROM gen_events WHERE database_id = ? ORDER BY start_time ASC`)
      .all(databaseId);
    if (rows.length === 0) return "No events.";
    return rows
      .map((e) =>
        e.all_day
          ? `#${e.id} — ${fmtIctDate(e.start_time)} (all day) — ${e.title}`
          : `#${e.id} — ${fmtIct(e.start_time)} to ${fmtIct(e.end_time)} — ${e.title}`
      )
      .join("\n");
  }

  async function deleteEvent(id) {
    if (!id) return "Usage: `.a db delete event <id>`";
    const row = storeDb.prepare(`SELECT discord_event_id FROM gen_events WHERE database_id = ? AND id = ?`).get(databaseId, Number(id));
    const result = storeDb.prepare(`DELETE FROM gen_events WHERE database_id = ? AND id = ?`).run(databaseId, Number(id));

    if (result.changes > 0 && row?.discord_event_id) {
      try {
        await onEventDelete(row.discord_event_id);
      } catch (err) {
        console.error(`[recordActions] failed to remove mirrored event (db ${databaseId}):`, err);
      }
    }

    return result.changes > 0 ? `Deleted event #${id}.` : `No event #${id}.`;
  }

  async function editEvent(args) {
    const { main, location: pipedLocation } = splitOnPipe(args);
    const [id, start, end, ...titleParts] = main;
    const title = titleParts.join(" ").trim();
    const startTime = parseIct(start);
    const endTime = parseIct(end);
    if (!id || !startTime || !endTime || !title || endTime <= startTime) {
      return "Usage: `.a db edit event <id> <start> <end> <title> [| <location>]` (replaces all fields, 24hr time, Indochina/Bangkok timezone; location unchanged if omitted)";
    }

    const existing = storeDb.prepare(`SELECT discord_event_id, location FROM gen_events WHERE database_id = ? AND id = ?`).get(databaseId, Number(id));
    const location = pipedLocation ?? existing?.location ?? databaseName;
    const result = storeDb
      .prepare(`UPDATE gen_events SET title = ?, title_normalized = ?, start_time = ?, end_time = ?, all_day = 0, location = ? WHERE database_id = ? AND id = ?`)
      .run(title, normalize(title), startTime.toISOString(), endTime.toISOString(), location, databaseId, Number(id));

    if (result.changes > 0 && existing?.discord_event_id) {
      try {
        await onEventUpdate(existing.discord_event_id, { title, start: startTime, end: endTime, location });
      } catch (err) {
        console.error(`[recordActions] failed to update mirrored event (db ${databaseId}):`, err);
      }
    }

    return result.changes > 0
      ? `Updated event #${id}: "${title}" from ${fmtIct(startTime.toISOString())} to ${fmtIct(endTime.toISOString())}`
      : `No event #${id}.`;
  }

  return { addReminderRecord, addReminder, listReminders, deleteReminder, editReminder, addEvent, listEvents, deleteEvent, editEvent };
}
