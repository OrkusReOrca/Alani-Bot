// ".a emo <run1|runany|runall> m<AU|T|VO|ET|HT dot-list|all> <d|s>"
//
//   run1    — process exactly one pending (not "DONE_"-prefixed) clip
//   runany  — process every pending clip found, however many
//   runall  — force-reprocess every clip in the Input folder, DONE or not
//
//   m<list> — which of the 5 modalities {AU,T,VO,ET,HT} to actually use in
//             the VLM prompt this run, dot-separated (e.g. "mAU.T"); "mall"
//             = all five.
//   d/s     — d: extract & cache ALL 5 modalities regardless of the m-list
//             (so a later run with a different m-list is instant, already
//             cached); s: only extract what's in the m-list this time.
//
// Owner-only (same DISCORD_OWNER_0/1 allowlist as ".a db"), and only usable
// in the one dedicated channel (DISCORD_EMOTION_CHANNEL) — this is a
// slow, resource-heavy command (video preprocessing + two VLM calls per
// clip), not something to expose broadly.
//
// This command only ever *starts* a run — it does not wait for results.
// "Alani Emotion" (the separate Python service, see the root README's
// "Emotion detection bridge" section) reports each finished clip back via
// its own bridge routes (see emotionApi.js), since preprocessing many
// clips can take far longer than any single Discord interaction should
// block on.

import { config } from "./config.js";
import { isOwner } from "../../common/auth.js";

export const data = {
  name: "emo",
};

const RUN_MODES = ["run1", "runany", "runall"];
const MODALITIES = ["AU", "T", "VO", "ET", "HT"];
const CACHE_MODES = ["d", "s"];

function usage() {
  return [
    "Usage: `.a emo <run1|runany|runall> m<AU|T|VO|ET|HT dot-list|all> <d|s>`",
    "e.g. `.a emo runany mAU.T d` — process every pending clip using AU+transcript, caching all 5 modalities for later.",
  ].join("\n");
}

function parseModalities(token) {
  if (!token || !token.toLowerCase().startsWith("m")) return null;
  const body = token.slice(1);
  if (body.toLowerCase() === "all") return [...MODALITIES];
  const wanted = body.split(".").map((m) => m.toUpperCase());
  if (wanted.length === 0 || wanted.some((m) => !MODALITIES.includes(m))) return null;
  return [...new Set(wanted)];
}

export async function execute(ctx, args = []) {
  if (!isOwner(ctx.userId)) {
    await ctx.reply("Unauthorized user, no permission");
    return;
  }
  if (!config.channelId || ctx.channelId !== config.channelId) {
    // Silent outside the dedicated channel — same posture as ".a db main"
    // replying only for owners elsewhere; here it just says nothing at all,
    // since a stray "wrong channel" reply for a command this narrow isn't
    // useful to anyone but the owner, who already knows the right channel.
    return;
  }

  const [runModeArg, modalityArg, cacheModeArg] = args;
  const runMode = RUN_MODES.includes(runModeArg) ? runModeArg : null;
  const modalities = parseModalities(modalityArg);
  const cacheMode = CACHE_MODES.includes(cacheModeArg) ? cacheModeArg : null;

  if (!runMode || !modalities || !cacheMode) {
    await ctx.reply(usage());
    return;
  }

  if (!config.serviceUrl || !config.serviceSecret) {
    await ctx.reply("Emotion service isn't configured yet — set EMOTION_SERVICE_URL + EMOTION_SERVICE_SECRET in .env.");
    return;
  }

  const cacheModeLabel = cacheMode === "d" ? "caching all 5 modalities" : "extracting only the requested modalities";
  await ctx.reply(
    `Starting \`${runMode}\` — using ${modalities.join("+")} (${cacheModeLabel}). Results will post here as each clip finishes.`
  );

  try {
    const res = await fetch(`${config.serviceUrl.replace(/\/$/, "")}/run`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.serviceSecret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ runMode, modalities, cacheMode, invokedBy: ctx.userId }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      await ctx.reply(`Couldn't start the run: ${res.status} ${res.statusText}${body ? ` — ${body}` : ""}`);
    }
  } catch (err) {
    await ctx.reply(`Couldn't reach the emotion service: ${err.message}`);
  }
}
