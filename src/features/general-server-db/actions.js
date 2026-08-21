// Handlers for a Tier-Server user's guild-scoped database — same shape as
// general-user-db/actions.js, but events also mirror to a real Discord
// Scheduled Event in the owning guild (instance.guild_id) via
// src/common/discordScheduledEvents.js, in addition to the local SQLite
// row. Mirroring is best-effort, same treatment orkus-info gives Google
// Calendar sync failures: logged inside recordActions.js's onEventCreate/
// Update/Delete hooks, never blocks or rolls back the local write that
// already succeeded.
//
// Still no Google Calendar sync — that stays exclusive to the Main tier
// (orkus-info). See root README's "Tiers" section.

import { createRecordActions } from "../../common/recordActions.js";
import { createScheduledEvent, updateScheduledEvent, deleteScheduledEvent } from "../../common/discordScheduledEvents.js";

function actionsFor(instance) {
  return createRecordActions({
    databaseId: instance.id,
    databaseName: instance.name,
    onEventCreate: async ({ title, start, end, location }) => {
      const discordEventId = await createScheduledEvent(instance.guild_id, { name: title, start, end, location });
      return { discordEventId };
    },
    onEventUpdate: async (discordEventId, { title, start, end, location }) => {
      await updateScheduledEvent(instance.guild_id, discordEventId, { name: title, start, end, location });
    },
    onEventDelete: async (discordEventId) => {
      await deleteScheduledEvent(instance.guild_id, discordEventId);
    },
  });
}

async function add(args, ctx, instance) {
  const [type, ...rest] = args;
  const actions = actionsFor(instance);
  if (type?.toLowerCase() === "reminder") return actions.addReminder(rest, ctx);
  if (type?.toLowerCase() === "event") return actions.addEvent(rest);
  return "Usage: `.a db add <reminder|event> ...`";
}

async function list(args, ctx, instance) {
  const [type] = args;
  const t = type?.toLowerCase();
  const actions = actionsFor(instance);
  if (t === "reminder" || t === "reminders") return actions.listReminders();
  if (t === "event" || t === "events") return actions.listEvents();
  return "Usage: `.a db list <reminders|events>`";
}

async function del(args, ctx, instance) {
  const [type, id] = args;
  const t = type?.toLowerCase();
  const actions = actionsFor(instance);
  if (t === "reminder") return actions.deleteReminder(id);
  if (t === "event") return actions.deleteEvent(id);
  return "Usage: `.a db delete <reminder|event> <id>`";
}

async function edit(args, ctx, instance) {
  const [type, ...rest] = args;
  const actions = actionsFor(instance);
  if (type?.toLowerCase() === "reminder") return actions.editReminder(rest);
  if (type?.toLowerCase() === "event") return actions.editEvent(rest);
  return "Usage: `.a db edit <reminder|event> <id> ...`";
}

export default { add, list, delete: del, edit };
