// ".a fjamtrack shop" — relays the most recently posted grid image into
// whichever channel asked, from local state (state.js's
// loadLastGridImage(), written by postGridImage.js right after each
// scheduled post). Deliberately doesn't need DISCORD_FORTNITE_CHANNEL_ID
// or any Discord API call of its own — it's not looking anything up
// remotely, just reading a file that's already there (committed back to
// the repo by the scheduled workflow, the same way state.json is).
//
// Also deliberately does NOT regenerate the grid live — that needs the
// `canvas` native module, which some hosts won't let build (bot-hosting.net's
// default script policy blocks it; this crashed the whole bot on startup,
// then failed on every use, before this design). The grid only actually
// changes once a day when the shop rotates, so "most recently posted" and
// "current" are the same thing almost all the time.
//
// Prefix-only for now — not registered as a slash command, since
// "fjamtrack shop" is a two-word name/subcommand that doesn't map onto a
// single slash command the way info's does.

import { loadLastGridImage } from "./state.js";

export const data = {
  name: "fjamtrack",
};

export async function execute(ctx, args = []) {
  const sub = args[0]?.toLowerCase();
  if (sub !== "shop") {
    await ctx.reply("Usage: `.a fjamtrack shop` — sends the current Jam Tracks shop grid.");
    return;
  }

  const last = loadLastGridImage();
  if (!last) {
    await ctx.reply("No grid image has been posted yet — the scheduled post may not have run.");
    return;
  }

  const res = await fetch(last.url);
  const buffer = Buffer.from(await res.arrayBuffer());
  await ctx.replyWithFile(buffer, last.filename);
}
