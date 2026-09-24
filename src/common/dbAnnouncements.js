// Status-channel announcements for database changes. Separate from
// statusLog.js because resolving a user ID / guild ID into a readable name
// needs the live Discord client, which the plain status poster (also used
// by the GitHub Actions scripts) deliberately doesn't depend on.

import { getClient } from "./discordClient.js";
import { statusDatabaseCreated, statusDatabaseUpdated } from "./statusLog.js";

async function displayNameOf(userId) {
  if (!userId) return "unknown";
  try {
    return (await getClient().users.fetch(userId)).username;
  } catch {
    return userId;
  }
}

function serverNameOf(guildId) {
  return (guildId && getClient().guilds.cache.get(guildId)?.name) || "DM";
}

// Fire-and-forget: a slow or failing announcement must never delay the
// command reply or fail the change that was already saved.
function fireAndForget(promise) {
  promise.catch((err) => console.error("[dbAnnouncements] failed:", err));
}

export function announceDatabaseCreated({ name, guildId, userId }) {
  fireAndForget(displayNameOf(userId).then((user) => statusDatabaseCreated({ name, server: serverNameOf(guildId), user })));
}

// change: what happened, e.g. "new reminder", "edited event", "deleted reminder".
export function announceDatabaseUpdated({ name, change, itemName, userId }) {
  fireAndForget(displayNameOf(userId).then((user) => statusDatabaseUpdated({ name, change, itemName, user })));
}
