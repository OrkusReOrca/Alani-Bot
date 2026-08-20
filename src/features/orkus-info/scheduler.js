// Fires due reminders — nothing else in orkus-info runs on a timer, this
// is the only piece that turns "a row sitting in SQLite" into an actual
// Discord message. Started once from bot.js's ClientReady handler (needs
// the client fully logged in — DM channel creation and channel fetches
// both need that).

import db from "./db.js";
import { getClient } from "../../common/discordClient.js";
import { fmtIct } from "./format.js";

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
  const due = db.prepare(`SELECT * FROM reminders WHERE remind_at <= ?`).all(new Date().toISOString());

  for (const reminder of due) {
    try {
      await fireReminder(reminder);
    } catch (err) {
      // Best-effort delivery — a closed-DM user, a deleted channel, etc.
      // shouldn't retry forever every 30s. Logged so it's visible in the
      // host's console, not just silently dropped.
      console.error(`[orkus-info] failed to fire reminder #${reminder.id}:`, err);
    } finally {
      db.prepare(`DELETE FROM reminders WHERE id = ?`).run(reminder.id);
    }
  }
}

export function startReminderScheduler() {
  setInterval(() => {
    fireDueReminders().catch((err) => console.error("[orkus-info] scheduler tick failed:", err));
  }, CHECK_INTERVAL_MS);
  console.log("[orkus-info] reminder scheduler started");
}
