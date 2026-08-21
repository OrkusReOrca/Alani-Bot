// Wraps Discord's native "Scheduled Events" feature (GUILD_SCHEDULED_EVENT
// — the calendar-style events a server can show under its Events tab),
// used by general-server-db's events (see
// src/features/general-server-db/actions.js) — the one place in this repo
// that mirrors an event out to something other than Google Calendar.
//
// Via discord.js's guild.scheduledEvents.* rather than raw REST (unlike
// googleCalendar.js's hand-rolled fetch+crypto): that pattern exists
// specifically to avoid installing a heavy Google SDK just for a JWT
// exchange and a few REST calls. discord.js is already a required, already
// -installed core dependency of this whole bot — there's no dependency
// weight to save by reimplementing what it already does correctly.
//
// Every event created this way is entityType "External" (not tied to a
// voice/stage channel — these are generic "something is happening"
// events), which is why a `location` string is required by Discord's own
// API — see general-server-db/actions.js for where that comes from.
// scheduledEndTime is also required for External events, unlike
// STAGE_INSTANCE/VOICE types, which is why every call site here must
// always pass a real end (general-server-db's own event logic already
// guarantees one exists, defaulting or computed, before calling in).
//
// Requires the bot to have the "Manage Events" permission in the target
// guild — if it doesn't, discord.js throws and the caller (actions.js)
// catches it the same best-effort way orkus-info catches Google Calendar
// failures: logged, never blocks the local SQLite write that already
// succeeded.

import { GuildScheduledEventEntityType, GuildScheduledEventPrivacyLevel } from "discord.js";
import { getClient } from "./discordClient.js";

export async function createScheduledEvent(guildId, { name, start, end, location }) {
  const guild = await getClient().guilds.fetch(guildId);
  const event = await guild.scheduledEvents.create({
    name,
    scheduledStartTime: start,
    scheduledEndTime: end,
    privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
    entityType: GuildScheduledEventEntityType.External,
    entityMetadata: { location },
  });
  return event.id;
}

export async function updateScheduledEvent(guildId, discordEventId, { name, start, end, location }) {
  const guild = await getClient().guilds.fetch(guildId);
  await guild.scheduledEvents.edit(discordEventId, {
    name,
    scheduledStartTime: start,
    scheduledEndTime: end,
    entityMetadata: { location },
  });
}

export async function deleteScheduledEvent(guildId, discordEventId) {
  const guild = await getClient().guilds.fetch(guildId);
  try {
    await guild.scheduledEvents.delete(discordEventId);
  } catch (err) {
    // Already gone (deleted directly in Discord, say) — not a real error,
    // same treatment as googleCalendar.js's 404/410 handling.
    if (err.code !== 10070 /* Unknown Guild Scheduled Event */) throw err;
  }
}
