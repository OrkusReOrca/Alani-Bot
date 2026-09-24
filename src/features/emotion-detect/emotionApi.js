// Bridge routes "Alani Emotion" (the separate Python service — see the
// root README's "Emotion detection bridge" section) calls back into, one
// per finished clip (POST /emotion/result) and once per whole run
// (POST /emotion/batch-done) — the actual Discord posting always happens
// here, never from the Python side, matching this repo's convention that
// only Alani-Bot ever talks to Discord directly.
//
// Registers into the shared bridge server (see common/bridgeServer.js),
// same pattern as db/voiceApi.js and uni-application-updater/pushApi.js —
// its own secret, so a leak here can only ever post messages to this one
// channel, nothing else.

import { config as botConfig } from "../../common/config.js";
import { config } from "./config.js";
import { sendViaBotChannel, sendFileViaBotChannel } from "../../common/discordApi.js";
import { sendJson, readJsonBody } from "../../common/http.js";
import { formatIctDateTime } from "../../common/time.js";

// "T+47.1s" / "T+1m12.4s"
function formatOffset(seconds) {
  const s = Math.max(0, seconds);
  if (s < 60) return `T+${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `T+${m}m${(s - m * 60).toFixed(1)}s`;
}

// One bullet-point message: two absolute GMT+7 times (clip uploaded, run
// command given = T+0) and three T+X offsets (preprocess done, VLM done,
// final message sent). The first two offsets come from the Python service
// (measured on its own clock from when it received /run); the last is
// measured here, on the same clock as the command's own T+0. A resent
// result has no meaningful "final message" offset (it went out long after
// the run), so it shows the resend time instead.
export function formatTimeline(timeline, nowMs) {
  const { uploadedAtMs, commandAtMs, preprocessDoneS, vlmDoneS, resent } = timeline;
  const lines = ["**Timeline** (GMT+7)"];
  lines.push(`• Clip uploaded: ${uploadedAtMs ? formatIctDateTime(uploadedAtMs, { seconds: true }) : "unknown"}`);
  lines.push(`• Run command given: ${commandAtMs ? `${formatIctDateTime(commandAtMs, { seconds: true })} — T+0` : "unknown"}`);
  lines.push(`• Preprocess finished: ${formatOffset(preprocessDoneS)}`);
  lines.push(`• VLM inference finished: ${formatOffset(vlmDoneS)}`);
  if (resent) {
    lines.push(`• Final message sent: resent at ${formatIctDateTime(nowMs, { seconds: true })} (original run's timing shown above)`);
  } else {
    lines.push(`• Final message sent: ${commandAtMs ? formatOffset((nowMs - commandAtMs) / 1000) : "unknown"}`);
  }
  return lines.join("\n");
}

// One prompt per message, wrapped in its own code fence. A prompt that
// still exceeds Discord's 2000-char limit alone (e.g. a long transcript)
// is split into several messages that each carry their own complete
// fence — chunkMessage() on the whole block would cut a fence in half.
async function sendPromptMessages(label, text) {
  const fence = "```";
  const overhead = `**${label} (99/99):**\n`.length + fence.length * 2 + 2;
  const limit = 2000 - overhead;
  const pieces = [];
  for (let i = 0; i < text.length; i += limit) pieces.push(text.slice(i, i + limit));
  for (let i = 0; i < pieces.length; i++) {
    const tag = pieces.length > 1 ? `**${label} (${i + 1}/${pieces.length}):**` : `**${label}:**`;
    await sendViaBotChannel(botConfig.botToken, config.channelId, `${tag}\n${fence}\n${pieces[i]}\n${fence}`);
  }
}

async function handleResult(req, res) {
  const payload = await readJsonBody(req);

  const { clipName, success, prediction, error, firstFrameBase64, valencePrompt, arousalPrompt, timeline } = payload;
  if (!clipName) return sendJson(res, 400, { error: "clipName is required" });

  const text = success
    ? `**${clipName}** → **${prediction}**`
    : `**${clipName}** → failed: ${error || "unknown error"}`;

  try {
    if (success && firstFrameBase64) {
      await sendFileViaBotChannel(
        botConfig.botToken,
        config.channelId,
        Buffer.from(firstFrameBase64, "base64"),
        "first_frame.jpg",
        text
      );
    } else {
      await sendViaBotChannel(botConfig.botToken, config.channelId, text);
    }

    // "more info" mode only — the full ValAro prompts, one message each
    // (see sendPromptMessages for why they aren't just chunkMessage()'d
    // together), then the timeline.
    if (success && valencePrompt) await sendPromptMessages("Valence prompt", valencePrompt);
    if (success && arousalPrompt) await sendPromptMessages("Arousal prompt", arousalPrompt);
    if (success && timeline) {
      await sendViaBotChannel(botConfig.botToken, config.channelId, formatTimeline(timeline, Date.now()));
    }
  } catch (err) {
    console.error("[emotionApi] failed to post result:", err);
  }

  sendJson(res, 200, { message: "posted" });
}

async function handleBatchDone(req, res) {
  const payload = await readJsonBody(req);

  const { total = 0, succeeded = 0, failed = 0 } = payload;
  const text = `Run finished — ${succeeded}/${total} succeeded${failed ? `, ${failed} failed` : ""}.`;

  try {
    await sendViaBotChannel(botConfig.botToken, config.channelId, text);
  } catch (err) {
    console.error("[emotionApi] failed to post batch summary:", err);
  }

  sendJson(res, 200, { message: "posted" });
}

export function registerEmotionRoutes(registerRoute) {
  if (!config.serviceSecret) {
    console.log("[emotionApi] EMOTION_SERVICE_SECRET not set — emotion bridge routes disabled");
    return;
  }
  if (!config.channelId) {
    console.log("[emotionApi] DISCORD_EMOTION_CHANNEL not set — emotion bridge routes disabled");
    return;
  }

  registerRoute("POST", "/emotion/result", config.serviceSecret, handleResult);
  registerRoute("POST", "/emotion/batch-done", config.serviceSecret, handleBatchDone);
}
