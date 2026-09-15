"""Alani Emotion's HTTP entrypoint — deliberately stdlib http.server, no
framework dependency, mirroring the minimalism of Alani-Bot's own
common/bridgeServer.js. One route: POST /run, which validates the shared
secret + request shape, kicks off pipeline.run() on a background thread
(so this returns immediately — see pipeline.py's own docstring for why),
and responds 202.
"""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import config
import pipeline
import resend

VALID_RUN_MODES = {"run1", "runany", "runall"}
VALID_MODALITIES = {"AU", "T", "VO", "ET", "HT"}
VALID_CACHE_MODES = {"d", "s"}


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

    def do_POST(self):
        if not config.SHARED_SECRET or not self._authorized():
            return self._send_json(401, {"error": "Unauthorized"})

        if self.path not in ("/run", "/resend"):
            return self._send_json(404, {"error": "Not found"})

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
        invoked_by = payload.get("invokedBy", "")

        if run_mode not in VALID_RUN_MODES:
            return self._send_json(400, {"error": f"runMode must be one of {sorted(VALID_RUN_MODES)}"})
        if not isinstance(modalities, list) or not modalities or any(m not in VALID_MODALITIES for m in modalities):
            return self._send_json(400, {"error": f"modalities must be a non-empty subset of {sorted(VALID_MODALITIES)}"})
        if cache_mode not in VALID_CACHE_MODES:
            return self._send_json(400, {"error": f"cacheMode must be one of {sorted(VALID_CACHE_MODES)}"})

        threading.Thread(
            target=pipeline.run, args=(run_mode, modalities, cache_mode, invoked_by), daemon=True
        ).start()
        self._send_json(202, {"message": "Run started."})

    def log_message(self, fmt, *args):
        print(f"[emotion-service] {self.address_string()} - {fmt % args}")


def main():
    if not config.SHARED_SECRET:
        print("[emotion-service] EMOTION_SERVICE_SECRET not set — refusing to start unauthenticated")
        return
    server = ThreadingHTTPServer(("0.0.0.0", config.LISTEN_PORT), Handler)
    print(f"[emotion-service] listening on port {config.LISTEN_PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
