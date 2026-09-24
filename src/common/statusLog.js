// One-line status updates in the dedicated status channel:
//
//   🟢 24/09/2026 14:05 == Online, Alani bot
//
// Times are DD/MM/YYYY HH:MM (24h) in ICT (GMT+7). Posting goes through
// Discord's REST API (not the gateway client), so it also works from the
// GitHub Actions scripts, which have a bot token but no live connection.
// A status post is a side effect of the real work and must never break it:
// failures are logged and swallowed.
//
// Reserved for later: 📧 "Email from **John Doe**" (an email-arrival line)
// once the email feature exists — add its kind here when it does.

import { config } from "./config.js";
import { sendViaBotChannel } from "./discordApi.js";
import { formatIctDateTime } from "./time.js";

const EMOJI = {
  online: "🟢",
  offline: "🔴",
  fortnite: "🇫",
  university: "🇺",
  cloudUpdated: "☁️",
  cloudFaulty: "☁️‼️",
  emotion: "🍋",
  database: "📀",
};

async function post(kind, text, { at = Date.now(), ping = "" } = {}) {
  if (!config.botToken || !config.statusChannelId) return;
  const line = `${EMOJI[kind]} ${formatIctDateTime(at)} == ${text}${ping ? ` ${ping}` : ""}`;
  try {
    await sendViaBotChannel(config.botToken, config.statusChannelId, line);
  } catch (err) {
    console.error(`[statusLog] failed to post "${kind}" status:`, err);
  }
}

export const statusOnline = () => post("online", "Online, Alani bot");

// `at` lets a crash detected on the next boot be stamped with the moment the
// bot was last seen alive rather than the time it was noticed.
export const statusOffline = ({ at, unexpected = false } = {}) =>
  post("offline", `Offline, Alani bot${unexpected ? " (shut down unexpectedly)" : ""}`, { at });

export const statusFortnite = () => post("fortnite", "Fortnite tracker sent");
export const statusUniversity = () => post("university", "University tracker updated");
export const statusCloudUpdated = (label) => post("cloudUpdated", `Database updated to cloud (${label})`);

// `ping` is a ready-made mention string (e.g. "<@123>") appended so the
// owner actually gets notified.
export const statusCloudFaulty = (label, { ping }) => post("cloudFaulty", `Faulty cloud update (${label})`, { ping });

export const statusEmotionCalled = (detail) => post("emotion", `Emotion recognition called (${detail})`);

export const statusDatabaseCreated = ({ name, server, user }) =>
  post("database", `Database **Created** name ***${name}*** at *${server}* by *${user}*`);

export const statusDatabaseUpdated = ({ name, change, itemName, user }) =>
  post("database", `Database **Updated** for ***${name}*** being *${change}* name *${itemName}* by *${user}*`);
