// The one HTTP server this bot exposes to authenticated non-Discord
// clients — bot-hosting.net gives this deployment exactly one exposed
// port (see db/voiceApi.js's own comment on that), so every bridge
// route (voice-Alani's, the uni-tracker push, any future one) shares
// this single server rather than each trying to bind its own port.
//
// Each route brings its own secret (checked as a bearer token) rather
// than one blanket secret for the whole server — a leaked uni-tracker
// push secret, say, should only ever be able to overwrite that one JSON
// file, not reach voice-Alani's reminder/db routes too.

import http from "http";
import { config } from "./config.js";
import { sendJson, BadRequestError } from "./http.js";
import { registerVoiceRoutes } from "../features/db/voiceApi.js";
import { registerUniTrackerPushRoute } from "../features/uni-application-updater/pushApi.js";
import { registerEmotionRoutes } from "../features/emotion-detect/emotionApi.js";

const routes = [];

export function registerRoute(method, path, secret, handler) {
  routes.push({ method, path, secret, handler });
}

// Every current route sends small JSON (a handful of KB at most, now that
// the emotion callback's first-frame image is shrunk before it's ever
// base64'd into a request body — see video.make_thumbnail()'s own
// comment for why that matters). This is a blunt, central backstop, not
// a replacement for keeping payloads small at the source: a several-MB
// request landing all at once, unread, in a container capped at 1GB RAM
// is a plausible way to OOM-crash the whole bot outright — rejecting it
// before ever buffering it into memory is cheap insurance against that,
// for this route and any future one.
const MAX_BODY_BYTES = 8 * 1024 * 1024;

export function startBridgeServer() {
  registerVoiceRoutes(registerRoute);
  registerUniTrackerPushRoute(registerRoute);
  registerEmotionRoutes(registerRoute);

  const server = http.createServer(async (req, res) => {
    const route = routes.find((r) => r.method === req.method && r.path === req.url);
    if (!route) return sendJson(res, 404, { error: "Not found" });
    if (!route.secret || req.headers.authorization !== `Bearer ${route.secret}`) {
      return sendJson(res, 401, { error: "Unauthorized" });
    }
    const contentLength = Number(req.headers["content-length"]);
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      return sendJson(res, 413, { error: `Body too large (max ${MAX_BODY_BYTES} bytes)` });
    }

    try {
      await route.handler(req, res);
    } catch (err) {
      if (err instanceof BadRequestError) return sendJson(res, 400, { error: err.message });
      console.error(`[bridgeServer] error handling ${req.method} ${req.url}:`, err);
      sendJson(res, 500, { error: "Internal error" });
    }
  });

  server.listen(config.voiceApiPort, () => {
    console.log(`[bridgeServer] listening on port ${config.voiceApiPort}`);
  });
}
