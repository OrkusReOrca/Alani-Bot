"""Alani Emotion's HTTP entrypoint — deliberately stdlib http.server, no
framework dependency, mirroring the minimalism of Alani-Bot's own
common/bridgeServer.js.

Two ways to use this service, ONE at a time on this slot:

  WEB DASHBOARD (DEMO_PASSWORD set) — a password-protected page served from
    this same process (web/, web_api.py): upload or record a video, watch the
    analysis progress, read the results. While it is on, the Discord/Drive flow
    below answers 503 — unless EMOTION_KEEP_DISCORD_FLOW=1.

  DISCORD / DRIVE FLOW (DEMO_PASSWORD unset, the original behaviour, kept as a
    backup) — POST /run validates the request, resolves the actual clip list
    SYNCHRONOUSLY (fast — just a Drive listing) so the response can tell
    Alani-Bot exactly which clips are about to run (for the Discord ack
    message), then kicks off the real work (pipeline.run_clips — slow:
    downloads, preprocessing, OpenRouter calls) on a background thread so
    this still returns quickly overall. POST /resend re-posts stored results.
    Both need "Authorization: Bearer <EMOTION_SERVICE_SECRET>".
"""

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import config
import web_api
import web_auth
import web_jobs

VALID_RUN_MODES = {"run1", "runany", "runall"}
VALID_MODALITIES = {"AU", "T", "VO", "ET", "HT"}
VALID_CACHE_MODES = {"d", "s"}


def discord_flow_enabled():
    """The old Discord/Drive flow is off while the web dashboard is on."""
    return not web_auth.enabled() or config.KEEP_DISCORD_FLOW


class Handler(BaseHTTPRequestHandler):
    def _send_json(self, status, body):
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _authorized(self):
        return self.headers.get("Authorization") == f"Bearer {config.SHARED_SECRET}"

    # ---- the web dashboard answers GET / HEAD / DELETE (and its own POSTs) ----
    def do_GET(self):
        if not web_api.handle(self, "GET"):
            self._send_json(404, {"error": "Not found"})

    def do_HEAD(self):
        if not web_api.handle(self, "HEAD"):
            self._send_json(404, {"error": "Not found"})

    def do_DELETE(self):
        if not web_api.handle(self, "DELETE"):
            self._send_json(404, {"error": "Not found"})

    def do_POST(self):
        if web_api.handle(self, "POST"):
            return
        received_at = time.time()
        if not config.SHARED_SECRET or not self._authorized():
            return self._send_json(401, {"error": "Unauthorized"})

        if self.path not in ("/run", "/resend"):
            return self._send_json(404, {"error": "Not found"})

        if not discord_flow_enabled():
            return self._send_json(
                503,
                {"error": "The emotion web dashboard is active, so the Discord/Drive flow is switched off. Use the dashboard (.a emo web)."},
            )

        # Imported here (not at the top) so the dashboard runs on machines
        # without the Drive/google libraries, and the web mode never loads them.
        import pipeline
        import resend

        length = int(self.headers.get("Content-Length", 0))
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            return self._send_json(400, {"error": "Invalid JSON body"})

        if self.path == "/resend":
            target = payload.get("target")
            invoked_by = payload.get("invokedBy", "")
            if not isinstance(target, str) or not target.strip():
                return self._send_json(400, {"error": "target must be 'all', 'recent', or a filename"})
            threading.Thread(target=resend.run, args=(target, invoked_by), daemon=True).start()
            return self._send_json(202, {"message": "Resend started."})

        run_mode = payload.get("runMode")
        modalities = payload.get("modalities")
        cache_mode = payload.get("cacheMode")
        more_info = bool(payload.get("moreInfo"))
        invoked_by = payload.get("invokedBy", "")
        command_at_ms = payload.get("commandAtMs")
        if not isinstance(command_at_ms, (int, float)):
            command_at_ms = None

        if run_mode not in VALID_RUN_MODES:
            return self._send_json(400, {"error": f"runMode must be one of {sorted(VALID_RUN_MODES)}"})
        if not isinstance(modalities, list) or not modalities or any(m not in VALID_MODALITIES for m in modalities):
            return self._send_json(400, {"error": f"modalities must be a non-empty subset of {sorted(VALID_MODALITIES)}"})
        if cache_mode not in VALID_CACHE_MODES:
            return self._send_json(400, {"error": f"cacheMode must be one of {sorted(VALID_CACHE_MODES)}"})

        try:
            clips = pipeline.resolve_clips(run_mode)
        except Exception as e:
            return self._send_json(502, {"error": f"Couldn't list Drive: {e}"})

        threading.Thread(
            target=pipeline.run_clips,
            args=(clips, modalities, cache_mode, invoked_by, run_mode, more_info, command_at_ms, received_at),
            daemon=True,
        ).start()
        self._send_json(202, {"message": "Run started.", "clipNames": [c["name"] for c in clips]})

    def log_message(self, fmt, *args):
        print(f"[emotion-service] {self.address_string()} - {fmt % args}")


def main():
    if not config.SHARED_SECRET:
        print("[emotion-service] EMOTION_SERVICE_SECRET not set — refusing to start unauthenticated")
        return

    if web_auth.enabled():
        web_jobs.start()
        print("[emotion-service] web dashboard ENABLED at /app/")
        if config.KEEP_DISCORD_FLOW:
            print("[emotion-service] Discord/Drive flow stays on (EMOTION_KEEP_DISCORD_FLOW=1)")
        else:
            print("[emotion-service] Discord/Drive flow is OFF while the dashboard is on (unset DEMO_PASSWORD to switch back)")
        if config.WARMUP_ON_START:
            web_api.start_warm_up()
    else:
        print("[emotion-service] DEMO_PASSWORD not set — web dashboard disabled, Discord/Drive flow active")

    server = ThreadingHTTPServer(("0.0.0.0", config.LISTEN_PORT), Handler)
    print(f"[emotion-service] listening on port {config.LISTEN_PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
