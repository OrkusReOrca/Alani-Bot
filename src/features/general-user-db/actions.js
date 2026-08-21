// Handlers for a single Tier-Personal user's private database — same
// add/list/delete/edit dispatch shape as orkus-info/actions.js (type
// first-arg: "reminder" vs "event"), but backed by the shared
// src/common/recordActions.js factory instead of its own SQL, scoped to
// whichever database instance src/features/db/command.js resolved (the
// 3rd arg, `instance`, from store.js). No Google Calendar sync, no
// Discord Scheduled Event — SQLite only, per the tier's design (see root
// README's "Tiers" section).
//
// createRecordActions() is called fresh per invocation (not cached),
// since `instance` (and therefore databaseId) differs per call depending
// on who's calling and which database they resolved to.

import { createRecordActions } from "../../common/recordActions.js";

function actionsFor(instance) {
  return createRecordActions({ databaseId: instance.id, databaseName: instance.name });
}

async function add(args, ctx, instance) {
  const [type, ...rest] = args;
  const actions = actionsFor(instance);
  if (type?.toLowerCase() === "reminder") return actions.addReminder(rest, ctx);
  if (type?.toLowerCase() === "event") return actions.addEvent(rest, ctx);
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
