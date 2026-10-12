// ".a emo <run1|runany|runall> m<AU|T|VO|ET|HT dot-list|all> <d|s> [mif]"
// ".a emo resend <all|recent|<filename>>"
// ".a emo web"
//
//   web     — the link to the emotion web dashboard (upload or record a video,
//             watch it being analysed, read the results) and whether it is up.
//             While the dashboard is on, the Alani Emotion slot switches the Drive
//             runs below off (it answers 503, which is explained to the user);
//             unset DEMO_PASSWORD on the slot to go back to them.
//
//   run1   — process exactly one pending (not "DONE_"-prefixed) clip
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
// Needs the AIallowed tag (bot owners always have it — see features/tags/),
// and only usable in the one dedicated channel (DISCORD_EMOTION_CHANNEL) — this is a
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
import { hasTag, TAGS } from "../tags/store.js";
import { statusEmotionCalled } from "../../common/statusLog.js";

export const data = {
  name: "emo",
};

export const aiGuide = `
.a emo <run1|runany|runall> m<modalities> <d|s> [mif]   — run the emotion-detection pipeline on video clips in Google Drive.
.a emo resend <all|recent|<filename>>                    — re-post already-computed results (no recompute).
.a emo web                                               — the link to the emotion web dashboard (upload or record a video there) and whether it is online. Use it when the user asks for the emotion website, dashboard, demo page or web board.
Arguments, in this exact order, no spaces inside a token:
- run mode: run1 = exactly one pending clip ("the latest video", "one video"); runany = every pending clip; runall = force-reprocess every clip, done or not.
- modalities: "m" + a dot-separated subset of AU (facial action units), T (transcript), VO (voice), ET (eye gaze), HT (head pose); e.g. mAU.T.VO; or mall for all five. What goes into the prompt.
- cache mode: d = also extract and cache ALL five modalities (user says "cache all of them"); s = extract only the listed ones.
- mif (optional, last): more info — also posts the full prompt text and an annotated frame (user says "more info").
Example: ".a emo run1 mAU.T.VO d mif". Needs the AIallowed tag and only responds in the emotion channel.`;

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
    "`.a emo web` — the link to the emotion web dashboard (while it is on, the Drive runs above are switched off).",
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
    if (res.status === 503) {
      await ctx.reply("The emotion web dashboard is active, so the Drive emotion runs are switched off. Use `.a emo web` to open the dashboard.");
      return null;
    }
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

// Is the dashboard answering? /api/health is public and tiny. Any failure (DNS,
// timeout, a non-200) just means "not answering" — this is a courtesy check.
export async function dashboardOnline(webUrl, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`${webUrl.replace(/\/$/, "")}/api/health`, { signal: AbortSignal.timeout(6000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function replyWithDashboard(ctx) {
  if (!config.webUrl) {
    await ctx.reply("The emotion dashboard address isn't set — add EMOTION_WEB_URL to .env (the slot's HTTPS address from its Domains tab).");
    return;
  }
  const url = `${config.webUrl.replace(/\/$/, "")}/app/`;
  const online = await dashboardOnline(config.webUrl);
  await ctx.reply(
    [
      `**Alani Emotion dashboard** — <${url}>`,
      online
        ? "🟢 Online. Log in with the demo password, then upload or record a video."
        : "🔴 Not answering right now — the slot may be asleep, restarting or stopped. Try again in a minute.",
    ].join("\n")
  );
}

export async function execute(ctx, args = []) {
  // T+0 for the "mif" timeline — captured before anything else runs.
  const commandAtMs = Date.now();
  if (!hasTag(ctx.userId, TAGS.AIallowed)) {
    await ctx.reply("You don't have permission to use `.a emo` — it needs the AIallowed tag, which only a bot owner can grant.");
    return;
  }
  if (!config.channelId || ctx.channelId !== config.channelId) {
    // Silent outside the dedicated channel (a stray "wrong channel" reply for
    // a command this narrow isn't useful to anyone) — except when .aii ran
    // it, where the assistant needs to know why nothing happened.
    if (ctx.viaAI) await ctx.reply("`.a emo` only works in the emotion channel.");
    return;
  }

  if (args[0]?.toLowerCase() === "web") {
    await replyWithDashboard(ctx);
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
