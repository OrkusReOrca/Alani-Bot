// Delivers due reminders of Alatomy account DBs on Discord. The reminders live on the Alatomy account
// service; every 30 seconds the bot asks it which ones are due (only accounts with a linked Discord
// login can be delivered to), sends each as a DM to the person (or into the channel they picked),
// and tells the service it was delivered so it is never sent again. Same message format as the other
// databases. Tracker reminders ("Have you ...?") work the same way: one DM per tracker and period,
// and none once the tracker is done for that period. Notices for an account (e.g. "your song was removed")
// are DMed the same way, once each. Accounts that switched Discord DMs off (Alani's settings) aren't
// listed by the service at all.

import { getClient } from "../../common/discordClient.js";
import { formatMentions } from "../../common/mentions.js";
import { fmtIct } from "../orkus-info/format.js";
import { accountClient } from "./client.js";
import { config as accountConfig } from "./config.js";

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

  const PERIOD_WORDS = { day: "today", week: "this week", month: "this month", year: "this year", once: "" };
  async function deliverTracker(tracker) {
    const progress = tracker.kind === "count" ? ` (${[`${tracker.count}/${tracker.target}`, PERIOD_WORDS[tracker.period]].filter(Boolean).join(" ")})` : "";
    const user = await discord().users.fetch(tracker.discordUserId);
    await user.send(`⏰ Have you? **${tracker.name}**${progress} — tick it off at ${accountConfig.webAppUrl}`);
  }

  async function deliverNotice(notice) {
    const user = await discord().users.fetch(notice.discordUserId);
    await user.send(`📣 ${notice.text}`);
  }

  async function tick() {
    if (!client.isConfigured()) return;
    for (const [id, at] of recentlySent) if (clock() - at > REMEMBER_MS) recentlySent.delete(id);

    for (const notice of await client.discordNotices()) {
      const key = `notice:${notice.id}`;
      if (!recentlySent.has(key)) {
        try {
          await deliverNotice(notice);
        } catch (error) {
          log.error(`[alatomy-account] failed to send notice ${notice.id}:`, error.message); // not retried
        }
        recentlySent.set(key, clock());
      }
      try {
        await client.markNoticeSent(notice.id);
      } catch (error) {
        log.error(`[alatomy-account] could not mark notice ${notice.id} as sent:`, error.message);
      }
    }

    const trackers = await client.dueTrackers();
    for (const tracker of trackers) {
      const key = `tracker:${tracker.trackerId}:${tracker.periodKey}`;
      if (!recentlySent.has(key)) {
        try {
          await deliverTracker(tracker);
        } catch (error) {
          log.error(`[alatomy-account] failed to send tracker reminder ${tracker.trackerId}:`, error);
        }
        recentlySent.set(key, clock());
      }
      try {
        await client.markTrackerNotified(tracker.trackerId, tracker.periodKey);
      } catch (error) {
        log.error(`[alatomy-account] could not mark tracker ${tracker.trackerId} as reminded:`, error.message);
      }
    }

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
