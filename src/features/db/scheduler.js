// Fires due reminders for the two tiered database kinds (general-user-db,
// general-server-db — gen_reminders in store.js). A deliberate near-copy
// of orkus-info/scheduler.js's fireDueReminders() rather than a shared
// import — orkus-info stays completely untouched (see root README's
// "Tiers" section), so this small duplication is accepted the same way
// src/common/recordActions.js's duplication of the dedup/overlap logic
// is. Started once from bot.js's ClientReady handler, same as orkus-info's.

import db from "./store.js";
import { getClient } from "../../common/discordClient.js";
import { fmtIct } from "../orkus-info/format.js";

const CHECK_INTERVAL_MS = 30 * 1000;

async function fireReminder(reminder) {
  const text = `🚨 REMINDER: *${reminder.text}* at ${fmtIct(reminder.remind_at)}`;

  if (reminder.channel_id) {
    const channel = await getClient().channels.fetch(reminder.channel_id);
    const user = await getClient().users.fetch(reminder.created_by);
    await channel.send(`${text} by *${user.username}*`);
  } else {
    const user = await getClient().users.fetch(reminder.created_by);
    await user.send(text);
  }
}

export async function fireDueReminders() {
  const due = db.prepare(`SELECT * FROM gen_reminders WHERE remind_at <= ?`).all(new Date().toISOString());

  for (const reminder of due) {
    try {
      await fireReminder(reminder);
    } catch (err) {
      console.error(`[db] failed to fire reminder #${reminder.id}:`, err);
    } finally {
      db.prepare(`DELETE FROM gen_reminders WHERE id = ?`).run(reminder.id);
    }
  }
}

export function startGenReminderScheduler() {
  setInterval(() => {
    fireDueReminders().catch((err) => console.error("[db] scheduler tick failed:", err));
  }, CHECK_INTERVAL_MS);
  console.log("[db] general-db reminder scheduler started");
}
