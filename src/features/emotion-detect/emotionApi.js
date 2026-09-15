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

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body;
}

async function handleResult(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: "Invalid JSON body" });
  }

  const { clipName, success, prediction, error, firstFrameBase64 } = payload;
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
  } catch (err) {
    console.error("[emotionApi] failed to post result:", err);
  }

  sendJson(res, 200, { message: "posted" });
}

async function handleBatchDone(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: "Invalid JSON body" });
  }

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
