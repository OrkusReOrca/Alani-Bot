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
//
// "refresh" (bot owners only — DISCORD_OWNER_0/1, see common/auth.js) is
// the on-demand escape hatch for the scheduled check/post workflows
// running significantly late (GitHub Actions cron is best-effort — see
// the root README's "A note on scheduled workflow timing"): it fires the
// `fortnite-jam-tracks-tracker-shop-refresh.yml` workflow via the GitHub
// API (src/common/githubActions.js) instead of waiting on the daily
// cron. Same canvas constraint as "shop" above means this can't just
// re-run check/post in-process on this host — it has to go through a
// real GitHub Actions runner, so this only confirms the run was
// triggered, not that it's finished; the actual update lands in the
// channel a minute or two later, same as the normal daily flow.

import { loadLastGridImage } from "./state.js";
import { isOwner } from "../../../common/auth.js";
import { dispatchWorkflow } from "../../../common/githubActions.js";

const REFRESH_WORKFLOW_FILE = "fortnite-jam-tracks-tracker-shop-refresh.yml";

export const data = {
  name: "fjamtrack",
};

function usage() {
  return [
    "Usage: `.a fjamtrack shop` — sends the current Jam Tracks shop grid.",
    "`.a fjamtrack refresh` — bot owners only: forces an immediate re-check + re-post.",
  ].join("\n");
}

async function handleRefresh(ctx) {
  if (!isOwner(ctx.userId)) {
    await ctx.reply("Unauthorized user, no permission");
    return;
  }
  try {
    await dispatchWorkflow(REFRESH_WORKFLOW_FILE);
    await ctx.reply("Triggered a fresh shop check + post — should land in the channel within a minute or two.");
  } catch (err) {
    console.error("fjamtrack refresh failed:", err);
    await ctx.reply(`Couldn't trigger the refresh: ${err.message}`);
  }
}

async function handleShop(ctx) {
  const last = loadLastGridImage();
  if (!last) {
    await ctx.reply("No grid image has been posted yet — the scheduled post may not have run.");
    return;
  }

  const res = await fetch(last.url);
  const buffer = Buffer.from(await res.arrayBuffer());
  await ctx.replyWithFile(buffer, last.filename);
}

export async function execute(ctx, args = []) {
  const sub = args[0]?.toLowerCase();
  if (sub === "refresh") {
    await handleRefresh(ctx);
    return;
  }
  if (sub !== "shop") {
    await ctx.reply(usage());
    return;
  }
  await handleShop(ctx);
}
