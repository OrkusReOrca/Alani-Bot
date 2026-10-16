// ".a stats" — usage numbers of Alatomy, for the bot owners: registered and active accounts, and page
// views of alatomy.com and of Alani on the web (bare counts kept by the Alatomy account service).
// Owners only, and only in the command-box channel. Prefix-only on purpose (no slash command), so it is
// not offered to everyone in the "/" menu.

import { isOwner } from "../../common/auth.js";
import { config as botConfig } from "../../common/config.js";
import { AccountApiError, accountClient } from "./client.js";
import { NOT_CONNECTED_HELP } from "./link.js";

export const data = { name: "stats" };

export const aiGuide = `
.a stats  — BOT OWNERS ONLY, command-box channel only: Alatomy usage numbers (registered accounts, active accounts in the last 24 h / 7 / 30 days, page views of alatomy.com and of Alani on the web today / 7 / 30 days / all time). Read-only.`;

const n = (value) => Number(value).toLocaleString("en-US");

export function formatStats(s) {
  const views = (v) => `today ${n(v.today)} · 7 days ${n(v.last7Days)} · 30 days ${n(v.last30Days)} · all time ${n(v.allTime)}`;
  return [
    "**Alatomy stats**",
    `**Accounts:** ${n(s.accounts.registered)} registered (+${n(s.accounts.newLast7Days)} in 7 days, +${n(s.accounts.newLast30Days)} in 30 days) · ${n(s.accounts.withDiscord)} with Discord · ${n(s.accounts.withGoogle)} with Google`,
    `**Active accounts:** 24 h ${n(s.active.last24Hours)} · 7 days ${n(s.active.last7Days)} · 30 days ${n(s.active.last30Days)}`,
    `**alatomy.com page views:** ${views(s.visits.website)}`,
    `**Alani web page views:** ${views(s.visits.alani)}`,
  ].join("\n");
}

export function createExecute({ client = accountClient, commandBox = () => botConfig.commandBoxChannelId } = {}) {
  return async function execute(ctx) {
    if (!isOwner(ctx.userId)) return void (await ctx.reply("Only the bot owners can see the stats."));
    if (!commandBox() || ctx.channelId !== commandBox()) return void (await ctx.reply("Use `.a stats` in the command box channel."));
    if (!client.isConfigured()) return void (await ctx.reply(NOT_CONNECTED_HELP));
    try {
      await ctx.reply(formatStats(await client.stats()));
    } catch (error) {
      if (!(error instanceof AccountApiError)) throw error;
      await ctx.reply(error.message);
    }
  };
}

export const execute = createExecute();
