// Builds the right createRecordActions() instance for a resolved
// database row (from src/features/db/store.js), regardless of kind.
// Extracted from what used to be a near-identical `actionsFor(instance)`
// duplicated in general-user-db/actions.js and general-server-db/
// actions.js — pure extraction, no behavior change (same risk profile
// as channelAccess.js's canSendInChannel extraction). Also used directly
// by voiceApi.js's database-targeted routes, which need the exact same
// per-instance wiring without going through either feature's own
// add/list/delete/edit dispatcher.

import { createRecordActions } from "./recordActions.js";
import { createScheduledEvent, updateScheduledEvent, deleteScheduledEvent } from "./discordScheduledEvents.js";

export function actionsForInstance(instance) {
  if (instance.kind === "server") {
    return createRecordActions({
      databaseId: instance.id,
      databaseName: instance.name,
      guildId: instance.guild_id,
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
  return createRecordActions({ databaseId: instance.id, databaseName: instance.name, guildId: instance.guild_id });
}
