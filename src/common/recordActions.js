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
import { extractQuoted } from "./textParsing.js";
import { resolveMentions, formatMentions } from "./mentions.js";
import { parseIct, fmtIct, fmtIctDate, startOfIctDay } from "../features/orkus-info/format.js";

const DEDUP_WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_EVENT_DURATION_MS = 60 * 60 * 1000;

function normalize(text) {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

// Same shape as orkus-info/actions.js's own copy — see that file's
// comment for the full reasoning (duplicated here, not shared, per this
// module's own top comment).
function stripTrailingModifiers(args, { allowMentions = false } = {}) {
  const rest = [...args];
  let force = false;
  let channelId = null;
  let mentions = null;

  while (rest.length > 0) {
    const last = rest[rest.length - 1];
    if (last.toLowerCase() === "force") {
      force = true;
      rest.pop();
    } else if (/^\d{15,20}$/.test(last)) {
      channelId = last;
      rest.pop();
    } else if (allowMentions && mentions === null) {
      mentions = last;
      rest.pop();
    } else {
      break;
    }
  }
  return { rest, force, channelId, mentions };
}

export function createRecordActions({
  databaseId,
  databaseName,
  guildId = null,
  onEventCreate = async () => ({}),
  onEventUpdate = async () => {},
  onEventDelete = async () => {},
}) {
  // ---------- reminders ----------

  async function addReminderRecord({ text, remindAt, channelId = null, createdBy, force = false, mentionIds = [], ctx = null }) {
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
        `INSERT INTO gen_reminders (database_id, text, text_normalized, remind_at, created_at, created_by, channel_id, display_number, mentions) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        databaseId,
        text,
        normalized,
        remindAt.toISOString(),
        new Date().toISOString(),
        createdBy,
        channelId,
        displayNumber,
        mentionIds.length > 0 ? mentionIds.join(",") : null
      );
    logEvent("reminder_created", createdBy, {
      databaseId,
      detail: { text, remindAt: remindAt.toISOString() },
      channelId: ctx?.channelId ?? null,
      guildId: ctx?.guildId ?? null,
    });

    const destination = channelId ? `will post in <#${channelId}>` : "will DM you";
    const mentionNote = mentionIds.length > 0 ? `, will also tag ${formatMentions(mentionIds)}` : "";
    return `Added reminder #${displayNumber}: "${text}" at ${fmtIct(remindAt.toISOString())} (${destination}${mentionNote})`;
  }

  // Reminder "name" field is quoted (`"..."`) so it can safely contain
  // spaces, commas, emoji — anything — same standard as orkus-info's own
  // reminders/events; see common/textParsing.js's extractQuoted().
  const ADD_REMINDER_USAGE =
    'Usage: `.a db [<name>] add reminder <YYYY-MM-DDTHH:MM> "<text>" [mentions] [channel-id] [force]` (24hr time, Indochina/Bangkok timezone; mentions is a comma-separated list of user IDs and/or usernames, tagged when the reminder fires)';

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
      // given; otherwise this database's own guild_id (populated at
      // creation for both kinds — see db/store.js) as the best fallback.
      let mentionGuildId = guildId;
      if (channelId) {
        try {
          mentionGuildId = (await getClient().channels.fetch(channelId))?.guildId ?? guildId;
        } catch {
          // keep the database's own guildId fallback
        }
      }
      const { resolved, unresolved } = await resolveMentions(mentions, mentionGuildId);
      if (unresolved.length > 0) {
        return `Couldn't resolve ${unresolved.map((u) => `"${u}"`).join(", ")} to a Discord user${mentionGuildId ? "" : " (no server context available to search by username — try their user ID instead)"} — fix and try again.`;
      }
      mentionIds = resolved;
    }

    return addReminderRecord({ text, remindAt, channelId, createdBy: ctx.userId, force, mentionIds, ctx });
  }

  function listReminders() {
    const rows = storeDb
      .prepare(`SELECT display_number, text, remind_at, channel_id, mentions FROM gen_reminders WHERE database_id = ? ORDER BY remind_at ASC`)
      .all(databaseId);
    if (rows.length === 0) return "No reminders.";
    return rows
      .map((r) => {
        const mentionNote = r.mentions ? `, tags ${formatMentions(r.mentions.split(","))}` : "";
        return `#${r.display_number} — ${fmtIct(r.remind_at)} — ${r.text} (${r.channel_id ? `<#${r.channel_id}>` : "DM"}${mentionNote})`;
      })
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
    const quoted = extractQuoted(args);
    const [displayNumber, when] = quoted?.before ?? [];
    const text = quoted?.text.trim();
    const remindAt = parseIct(when);
    if (!displayNumber || !remindAt || !text) {
      return 'Usage: `.a db edit reminder <id> <YYYY-MM-DDTHH:MM> "<text>"` (replaces both fields; destination/channel/mentions unchanged — delete and re-add to change those)';
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
    'Usage: `.a db add event <start> [end|allday] "<title>" [| <location>] [force]` (24hr time, Indochina/Bangkok timezone, e.g. 2026-08-25T15:00 — year/month optional, assumes current; end defaults to 1 hour after start if omitted; use `allday` in place of end for an all-day event; `| <location>` is optional, defaults to this database\'s name; add `force` at the end to skip the duplicate check)';

  // Splits the tokens AFTER a quoted title's closing quote on a literal
  // "|" — everything before it (if any) is checked for "force", everything
  // after (joined back with spaces) is the location. Location itself
  // isn't quoted (only the title/text "name" fields are, per the
  // standard) — it's just whatever's left, same as before this file's
  // title parsing switched to quotes.
  function parseEventModifiers(tokens) {
    const pipeIdx = tokens.indexOf("|");
    const modifierTokens = pipeIdx === -1 ? tokens : tokens.slice(0, pipeIdx);
    const location = pipeIdx === -1 ? null : tokens.slice(pipeIdx + 1).join(" ").trim() || null;
    const force = modifierTokens.some((t) => t.toLowerCase() === "force");
    return { force, location };
  }

  async function addEvent(args, ctx = null) {
    const quoted = extractQuoted(args);
    if (!quoted) return ADD_EVENT_USAGE;
    const { force, location: pipedLocation } = parseEventModifiers(quoted.after);
    const [startRaw, second] = quoted.before;
    const parsedStart = parseIct(startRaw);
    if (!parsedStart) return ADD_EVENT_USAGE;

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
    const quoted = extractQuoted(args);
    const [id, start, end] = quoted?.before ?? [];
    const title = quoted?.text.trim();
    const { location: pipedLocation } = parseEventModifiers(quoted?.after ?? []);
    const startTime = parseIct(start);
    const endTime = parseIct(end);
    if (!id || !startTime || !endTime || !title || endTime <= startTime) {
      return 'Usage: `.a db edit event <id> <start> <end> "<title>" [| <location>]` (replaces all fields, 24hr time, Indochina/Bangkok timezone; location unchanged if omitted)';
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
