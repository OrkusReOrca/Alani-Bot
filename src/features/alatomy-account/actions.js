// The "Alatomy account DB" as a `.a db` database kind: same add / list / delete / edit verbs and the
// same wording as the other databases, but the data lives in the person's Alatomy account (on the
// Alatomy website service), so the very same reminders and events show up in the web app.
//
// Parsing is shared with the local databases (common/recordParsing.js); the rules (duplicates,
// overlaps, numbering, limits) are applied by the service. Discord-only details (can the bot post in
// that channel? who is that mentioned username?) are checked here, before anything is saved.

import { canSendInChannel } from "../../common/channelAccess.js";
import { getClient } from "../../common/discordClient.js";
import { formatMentions, resolveMentions } from "../../common/mentions.js";
import { parseAddEvent, parseAddReminder, parseEditEvent, parseEditReminder } from "../../common/recordParsing.js";
import { fmtIct, fmtIctDate } from "../orkus-info/format.js";
import { accountClient } from "./client.js";

const reminderLine = (r) => {
  const mentionNote = r.mentions?.length ? `, tags ${formatMentions(r.mentions)}` : "";
  return `#${r.displayNumber} — ${fmtIct(r.remindAt)} — ${r.text} (${r.channelId ? `<#${r.channelId}>` : "DM"}${mentionNote})`;
};
const eventLine = (e) => (e.allDay ? `#${e.displayNumber} — ${fmtIctDate(e.start)} (all day) — ${e.title}` : `#${e.displayNumber} — ${fmtIct(e.start)} to ${fmtIct(e.end)} — ${e.title}`);

export function createAccountActions(client = accountClient) {
  const accountIdOf = (instance) => instance.account.id;

  // ---------------------------------------------------------------- reminders
  async function addReminder(args, ctx, instance) {
    const parsed = parseAddReminder(args);
    if (parsed.usage) return parsed.usage;
    const { text, remindAt, force, channelId, mentions } = parsed;

    let guildId = ctx.guildId ?? null;
    if (channelId) {
      const discord = getClient();
      let channel;
      try {
        channel = await discord.channels.fetch(channelId);
      } catch {
        channel = null;
      }
      if (!(await canSendInChannel(discord, channel))) {
        return `Can't send in channel \`${channelId}\` — check the ID and that Alani has permission to post there, then try again.`;
      }
      guildId = channel.guildId ?? guildId;
    }

    let mentionIds = [];
    if (mentions) {
      const { resolved, unresolved } = await resolveMentions(mentions, guildId);
      if (unresolved.length > 0) {
        return `Couldn't resolve ${unresolved.map((u) => `"${u}"`).join(", ")} to a Discord user${guildId ? "" : " (no server context available to search by username — try their user ID instead)"} — fix and try again.`;
      }
      mentionIds = resolved;
    }

    const result = await client.addReminder(accountIdOf(instance), { text, remindAt: remindAt.toISOString(), channelId, mentions: mentionIds, force });
    if (result.ok) {
      const r = result.data.reminder;
      const destination = r.channelId ? `will post in <#${r.channelId}>` : "will DM you";
      const mentionNote = r.mentions.length > 0 ? `, will also tag ${formatMentions(r.mentions)}` : "";
      return `Added reminder #${r.displayNumber}: "${r.text}" at ${fmtIct(r.remindAt)} (${destination}${mentionNote})`;
    }
    if (result.data.code === "duplicate") {
      const d = result.data.duplicate;
      return `Already have a similar reminder — #${d.displayNumber} "${d.text}" at ${fmtIct(d.remindAt)} — not adding a duplicate. Add \`force\` at the end to add it anyway.`;
    }
    return result.data.error ?? "Couldn't add that reminder.";
  }

  // Only what is still to come: reminders ticked off on the web, or already delivered, stay in the web
  // app's list for a while but are finished here.
  async function listReminders(instance) {
    const reminders = (await client.listReminders(accountIdOf(instance))).filter((r) => !r.doneAt && !r.deliveredAt);
    return reminders.length === 0 ? "No reminders." : reminders.map(reminderLine).join("\n");
  }

  async function deleteReminder(number, instance) {
    if (!number) return "Usage: `.a db delete reminder <id|all>`";
    if (number.toLowerCase() === "all") {
      const { data } = await client.deleteAllReminders(accountIdOf(instance));
      return data.deleted > 0 ? `Deleted all ${data.deleted} reminder(s).` : "No reminders to delete.";
    }
    const result = await client.deleteReminder(accountIdOf(instance), number);
    return result.ok ? `Deleted reminder #${number}.` : `No reminder #${number}.`;
  }

  async function editReminder(args, instance) {
    const parsed = parseEditReminder(args);
    if (parsed.usage) return parsed.usage;
    const result = await client.updateReminder(accountIdOf(instance), parsed.displayNumber, { text: parsed.text, remindAt: parsed.remindAt.toISOString() });
    if (!result.ok) return result.data.code === "not_found" ? `No reminder #${parsed.displayNumber}.` : result.data.error ?? "Couldn't update that reminder.";
    return `Updated reminder #${parsed.displayNumber}: "${result.data.reminder.text}" at ${fmtIct(result.data.reminder.remindAt)}`;
  }

  // ------------------------------------------------------------------- events
  async function addEvent(args, instance) {
    const parsed = parseAddEvent(args);
    if (parsed.usage) return parsed.usage;
    const { title, startTime, endTime, allDay, force, location } = parsed;
    const result = await client.addEvent(accountIdOf(instance), { title, start: startTime.toISOString(), end: endTime.toISOString(), allDay, location, force });
    if (!result.ok) {
      if (result.data.code === "duplicate") {
        const d = result.data.duplicate;
        return `Already have a similar event — #${d.displayNumber} "${d.title}" at ${fmtIct(d.start)} — not adding a duplicate. Add \`force\` at the end to add it anyway.`;
      }
      return result.data.error ?? "Couldn't add that event.";
    }
    const e = result.data.event;
    const when = e.allDay ? `all day ${fmtIctDate(e.start)}` : `from ${fmtIct(e.start)} to ${fmtIct(e.end)}`;
    let reply = `Added event #${e.displayNumber}: "${e.title}" ${when}`;
    if (result.data.overlaps.length > 0) {
      reply += `\n⚠️ Overlaps with: ${result.data.overlaps.map((o) => `"${o.title}" (${fmtIct(o.start)} - ${fmtIct(o.end)})`).join(", ")}`;
    }
    return reply;
  }

  async function listEvents(instance) {
    const events = await client.listEvents(accountIdOf(instance));
    return events.length === 0 ? "No events." : events.map(eventLine).join("\n");
  }

  async function deleteEvent(number, instance) {
    if (!number) return "Usage: `.a db delete event <id>`";
    const result = await client.deleteEvent(accountIdOf(instance), number);
    return result.ok ? `Deleted event #${number}.` : `No event #${number}.`;
  }

  async function editEvent(args, instance) {
    const parsed = parseEditEvent(args);
    if (parsed.usage) return parsed.usage;
    const body = { title: parsed.title, start: parsed.startTime.toISOString(), end: parsed.endTime.toISOString(), ...(parsed.location ? { location: parsed.location } : {}) };
    const result = await client.updateEvent(accountIdOf(instance), parsed.id, body);
    if (!result.ok) return result.data.code === "not_found" ? `No event #${parsed.id}.` : result.data.error ?? "Couldn't update that event.";
    const e = result.data.event;
    return `Updated event #${parsed.id}: "${e.title}" from ${fmtIct(e.start)} to ${fmtIct(e.end)}`;
  }

  // The registry's handler shape: (args, ctx, instance) -> reply text.
  return {
    async add([type, ...rest], ctx, instance) {
      const t = type?.toLowerCase();
      if (t === "reminder") return addReminder(rest, ctx, instance);
      if (t === "event") return addEvent(rest, instance);
      return "Usage: `.a db add <reminder|event> ...`";
    },
    async list([type], ctx, instance) {
      const t = type?.toLowerCase();
      if (t === "reminder" || t === "reminders") return listReminders(instance);
      if (t === "event" || t === "events") return listEvents(instance);
      return "Usage: `.a db list <reminders|events>`";
    },
    async delete([type, id], ctx, instance) {
      const t = type?.toLowerCase();
      if (t === "reminder") return deleteReminder(id, instance);
      if (t === "event") return deleteEvent(id, instance);
      return "Usage: `.a db delete <reminder|event> <id>`";
    },
    async edit([type, ...rest], ctx, instance) {
      const t = type?.toLowerCase();
      if (t === "reminder") return editReminder(rest, instance);
      if (t === "event") return editEvent(rest, instance);
      return "Usage: `.a db edit <reminder|event> <id> ...`";
    },
  };
}

export default createAccountActions();
