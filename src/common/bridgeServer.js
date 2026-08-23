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
import { registerVoiceRoutes } from "../features/db/voiceApi.js";
import { registerUniTrackerPushRoute } from "../features/uni-application-updater/pushApi.js";

const routes = [];

export function registerRoute(method, path, secret, handler) {
  routes.push({ method, path, secret, handler });
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export function startBridgeServer() {
  registerVoiceRoutes(registerRoute);
  registerUniTrackerPushRoute(registerRoute);

  const server = http.createServer(async (req, res) => {
    const route = routes.find((r) => r.method === req.method && r.path === req.url);
    if (!route) return sendJson(res, 404, { error: "Not found" });
    if (!route.secret || req.headers.authorization !== `Bearer ${route.secret}`) {
      return sendJson(res, 401, { error: "Unauthorized" });
    }

    try {
      await route.handler(req, res);
    } catch (err) {
      console.error(`[bridgeServer] error handling ${req.method} ${req.url}:`, err);
      sendJson(res, 500, { error: "Internal error" });
    }
  });

  server.listen(config.voiceApiPort, () => {
    console.log(`[bridgeServer] listening on port ${config.voiceApiPort}`);
  });
}
