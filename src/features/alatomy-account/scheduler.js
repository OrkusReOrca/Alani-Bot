// Delivers due reminders of Alatomy account DBs on Discord. The reminders live on the Alatomy account
// service; every 30 seconds the bot asks it which ones are due (only accounts with a linked Discord
// login can be delivered to), sends each as a DM to the person (or into the channel they picked),
// and tells the service it is done so it is removed. Same message format as the other databases.

import { getClient } from "../../common/discordClient.js";
import { formatMentions } from "../../common/mentions.js";
import { fmtIct } from "../orkus-info/format.js";
import { accountClient } from "./client.js";

const CHECK_INTERVAL_MS = 30 * 1000;
const REMEMBER_MS = 15 * 60 * 1000;

export function createAccountReminderScheduler({ client = accountClient, discord = getClient, log = console, clock = Date.now } = {}) {
  // If "done" cannot be reported (the service is briefly down), the reminder would come back on the next
  // tick; remembering what was just sent stops it being sent twice.
  const recentlySent = new Map(); // reminder id -> time sent

  async function deliver(reminder) {
    const text = `🚨 REMINDER: *${reminder.text}* at ${fmtIct(reminder.remindAt)}`;
    const mentions = reminder.mentions.length > 0 ? formatMentions(reminder.mentions) : "";
    const user = await discord().users.fetch(reminder.discordUserId);
    if (reminder.channelId) {
      const channel = await discord().channels.fetch(reminder.channelId);
      await channel.send(`${text} by *${user.username}*${mentions ? ` ${mentions}` : ""}`);
    } else {
      await user.send(`${text}${mentions ? ` ${mentions}` : ""}`);
    }
  }

  async function tick() {
    if (!client.isConfigured()) return;
    for (const [id, at] of recentlySent) if (clock() - at > REMEMBER_MS) recentlySent.delete(id);

    const due = await client.dueReminders();
    for (const reminder of due) {
      if (!recentlySent.has(reminder.id)) {
        try {
          await deliver(reminder);
        } catch (error) {
          // like the other databases: a reminder that cannot be delivered is dropped, not retried forever
          log.error(`[alatomy-account] failed to deliver reminder ${reminder.id}:`, error);
        }
        recentlySent.set(reminder.id, clock());
      }
      try {
        await client.markDelivered(reminder.id);
      } catch (error) {
        log.error(`[alatomy-account] could not mark reminder ${reminder.id} as delivered:`, error.message);
      }
    }
  }

  return {
    tick,
    start() {
      if (!client.isConfigured()) {
        log.log("[alatomy-account] ALATOMY_ACCOUNT_API_URL / ALATOMY_ACCOUNT_API_SECRET not set: account reminders are off");
        return null;
      }
      const timer = setInterval(() => tick().catch((error) => log.error("[alatomy-account] reminder check failed:", error.message)), CHECK_INTERVAL_MS);
      log.log("[alatomy-account] account reminder scheduler started");
      return timer;
    },
  };
}

export const startAccountReminderScheduler = () => createAccountReminderScheduler().start();
