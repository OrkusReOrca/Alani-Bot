// ".a emo <run1|runany|runall> m<AU|T|VO|ET|HT dot-list|all> <d|s> [mif]"
// ".a emo resend <all|recent|<filename>>"
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
//   mif     — optional, "more info": each result also gets the full VLM
//             prompt text (both ValAro steps) as a follow-up message, and
//             the attached image is py-feat's own annotated frame (face
//             box, landmarks, AU bars, head pose) instead of the plain
//             first frame. Left off = today's normal, lighter result.
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
//
// "resend" is a separate, much cheaper mode: it re-posts already-computed
// results straight from Alani Emotion's own records, with no Drive
// listing, no preprocessing, and no OpenRouter calls at all. Exists for
// exactly the failure mode seen in practice — a run finishes successfully
// (clip marked DONE_, prediction computed) but the final callback to this
// bot never arrives because of a transient network blip between the two
// containers. Redoing the whole expensive pipeline just to redeliver a
// result that already exists would be wasteful.

import { config } from "./config.js";
import { isOwner } from "../../common/auth.js";
import { statusEmotionCalled } from "../../common/statusLog.js";

export const data = {
  name: "emo",
};

const RUN_MODES = ["run1", "runany", "runall"];
const MODALITIES = ["AU", "T", "VO", "ET", "HT"];
const CACHE_MODES = ["d", "s"];
const RESEND_TARGETS = ["all", "recent"]; // plus any literal filename

function usage() {
  return [
    "Usage: `.a emo <run1|runany|runall> m<AU|T|VO|ET|HT dot-list|all> <d|s> [mif]`",
    "e.g. `.a emo runany mAU.T d` — process every pending clip using AU+transcript, caching all 5 modalities for later.",
    "Add `mif` at the end for more info per result (full prompt text + annotated frame).",
    "`.a emo resend <all|recent|<filename>>` — re-send already-computed results (no recompute, no OpenRouter calls).",
  ].join("\n");
}

// Shared by both /run and /resend — returns the parsed JSON response body
// on success, or null (having already replied with the error) on failure.
// /run's own response includes clipNames, which callers use to make the
// ack message name the clips actually about to run, rather than a vague
// "started" with no idea what's queued.
async function startService(path, body, ctx) {
  try {
    const res = await fetch(`${config.serviceUrl.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.serviceSecret}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const responseBody = await res.text().catch(() => "");
    if (!res.ok) {
      await ctx.reply(`Couldn't start it: ${res.status} ${res.statusText}${responseBody ? ` — ${responseBody}` : ""}`);
      return null;
    }
    try {
      return JSON.parse(responseBody);
    } catch {
      return {};
    }
  } catch (err) {
    await ctx.reply(`Couldn't reach the emotion service: ${err.message}`);
    return null;
  }
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
  // T+0 for the "mif" timeline — captured before anything else runs.
  const commandAtMs = Date.now();
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

  if (!config.serviceUrl || !config.serviceSecret) {
    await ctx.reply("Emotion service isn't configured yet — set EMOTION_SERVICE_URL + EMOTION_SERVICE_SECRET in .env.");
    return;
  }

  if (args[0]?.toLowerCase() === "resend") {
    // Everything after "resend" joined back together, so a filename can
    // still contain spaces even though args are whitespace-split —
    // "all"/"recent" are single words either way, unaffected by the join.
    const target = args.slice(1).join(" ").trim();
    if (!target) {
      await ctx.reply(usage());
      return;
    }
    const targetLabel = RESEND_TARGETS.includes(target.toLowerCase()) ? `\`${target}\`` : `clip "${target}"`;
    await ctx.reply(`Resending already-computed results for ${targetLabel} — no recompute, no OpenRouter calls.`);
    await startService("/resend", { target, invokedBy: ctx.userId }, ctx);
    return;
  }

  const [runModeArg, modalityArg, cacheModeArg, moreInfoArg] = args;
  const runMode = RUN_MODES.includes(runModeArg) ? runModeArg : null;
  const modalities = parseModalities(modalityArg);
  const cacheMode = CACHE_MODES.includes(cacheModeArg) ? cacheModeArg : null;
  // The 4th arg is optional and, when present, must be exactly "mif" —
  // anything else there is a typo worth rejecting rather than silently
  // ignoring.
  const moreInfoValid = moreInfoArg === undefined || moreInfoArg.toLowerCase() === "mif";
  const moreInfo = moreInfoArg?.toLowerCase() === "mif";

  if (!runMode || !modalities || !cacheMode || !moreInfoValid) {
    await ctx.reply(usage());
    return;
  }

  // Called BEFORE the ack (unlike resend's own flow) specifically so the
  // ack can name the clips it resolved — resolving is fast (just a Drive
  // listing; see pipeline.resolve_clips), the actual slow work only
  // starts once this responds.
  const response = await startService("/run", { runMode, modalities, cacheMode, moreInfo, commandAtMs, invokedBy: ctx.userId }, ctx);
  if (!response) return; // startService already replied with the error

  const clipNames = response.clipNames ?? [];
  const cacheModeLabel = cacheMode === "d" ? "caching all 5 modalities" : "extracting only the requested modalities";
  const moreInfoLabel = moreInfo ? ", with full prompt + annotated frame per result" : "";
  const clipsLabel =
    clipNames.length === 0 ? "no pending clips found" : `${clipNames.length} clip(s): ${clipNames.join(", ")}`;
  await ctx.reply(
    `Starting \`${runMode}\` — using ${modalities.join("+")} (${cacheModeLabel}${moreInfoLabel}). ${clipsLabel}.` +
      (clipNames.length > 0 ? " Results will post here as each clip finishes." : "")
  );
  statusEmotionCalled(`${runMode}, ${clipNames.length} clip(s)`);
}
