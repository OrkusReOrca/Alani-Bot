// The real-world wiring of the trackers: the database, the reminder engine with
// Discord delivery, and the dependencies the `.at` command is built from. Kept
// apart from command.js so tests can build the command from fakes.

import path from "path";
import { config } from "../../common/config.js";
import { sendViaDM, sendViaBotChannel } from "../../common/discordApi.js";
import { getClient } from "../../common/discordClient.js";
import { canSendInChannel } from "../../common/channelAccess.js";
import { resolveMentions } from "../../common/mentions.js";
import { hasTag, TAGS } from "../tags/store.js";
import { store, TRACKER_DATA_DIR } from "./store.js";
import { createReminderState } from "./reminderState.js";
import { createReminderEngine } from "./reminders.js";

// Reminders may ping the people they tag, but never @everyone or a role.
const USER_MENTIONS_ONLY = { parse: ["users"] };

export const reminderState = createReminderState(path.join(TRACKER_DATA_DIR, "reminder-state.json"));

export const engine = createReminderEngine({
  store,
  state: reminderState,
  delivery: {
    dm: (userId, text) => sendViaDM(config.botToken, userId, text),
    channel: (channelId, text) => sendViaBotChannel(config.botToken, channelId, text, { allowedMentions: USER_MENTIONS_ONLY }),
  },
});

// null if the bot can post in that channel (and, for a server's tracker, the channel belongs to that server).
async function checkChannel(channelId, guildId) {
  const client = getClient();
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!(await canSendInChannel(client, channel))) return `Can't send in channel \`${channelId}\` — check the ID and that Alani can post there.`;
  if (guildId && channel.guildId !== guildId) return "A server tracker can only send to a channel of its own server.";
  return null;
}

export const defaultDeps = {
  store,
  engine,
  now: () => Date.now(),
  hasTrackerTag: (userId) => hasTag(userId, TAGS.Tracker),
  resolveUsers: (text, guildId) => resolveMentions(text, guildId),
  checkChannel,
};
