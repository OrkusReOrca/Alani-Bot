// ".a fjamtrack shop" — relays the most recently posted grid image from
// the tracking channel into whichever channel asked.
//
// Deliberately does NOT regenerate the grid live (that needs the `canvas`
// native module, which some hosts — including bot-hosting.net's default
// script-execution policy — won't let build; this command crashed the
// whole bot on startup, then failed on every use, before this fix). The
// scheduled workflow (postGridImage.js, run via GitHub Actions, which has
// a real build toolchain) already renders and posts a fresh grid daily —
// this just re-sends that. In practice the grid only changes once a day
// when the shop rotates, so "most recently posted" and "current" are the
// same thing almost all the time.
//
// Prefix-only for now — not registered as a slash command, since
// "fjamtrack shop" is a two-word name/subcommand that doesn't map onto a
// single slash command the way info's does.

import { config } from "./config.js";
import { getLatestImageAttachment } from "../../../common/discordApi.js";

export const data = {
  name: "fjamtrack",
};

export async function execute(ctx, args = []) {
  const sub = args[0]?.toLowerCase();
  if (sub !== "shop") {
    await ctx.reply("Usage: `.a fjamtrack shop` — sends the current Jam Tracks shop grid.");
    return;
  }

  if (!config.botToken || !config.channelId) {
    await ctx.reply("Not configured — missing DISCORD_FORTNITE_CHANNEL_ID.");
    return;
  }

  const latest = await getLatestImageAttachment(config.botToken, config.channelId);
  if (!latest) {
    await ctx.reply(
      "Couldn't find a recent grid image in the tracking channel — the scheduled post may not have run yet."
    );
    return;
  }

  const res = await fetch(latest.url);
  const buffer = Buffer.from(await res.arrayBuffer());
  await ctx.replyWithFile(buffer, latest.filename);
}
