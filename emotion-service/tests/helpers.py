"""Shared test scaffolding: a real ThreadingHTTPServer on a free port, the fake
pipeline, and a throwaway data directory — so the dashboard is tested through
actual HTTP requests, with none of torch / py-feat / whisper / ffmpeg."""

import http.client
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest
from http.server import ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import config  # noqa: E402
import fake_pipeline  # noqa: E402
import store  # noqa: E402
import web_auth  # noqa: E402
import web_jobs  # noqa: E402
import web_ratelimit  # noqa: E402

CSRF = {"X-Requested-With": "alani-web"}


class WebTestCase(unittest.TestCase):
    PASSWORD = "demo-pass"
    SECRET = "bot-secret"

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="emotion_test_")
        self._saved = {k: getattr(config, k) for k in (
            "DATA_DIR", "DEMO_PASSWORD", "SHARED_SECRET", "FAKE_PIPELINE", "WEB_MAX_UPLOAD_MB", "WEB_MAX_JOBS_PER_HOUR",
            "WEB_RETENTION_HOURS", "KEEP_DISCORD_FLOW", "WEB_SESSION_KEY", "OPENROUTER_API_KEY",
            "WEB_RATE_PER_MIN", "WEB_RATE_GLOBAL_PER_MIN", "WEB_UPLOADS_PER_HOUR_PER_IP", "WEB_MAX_CONCURRENT_UPLOADS")}
        config.DATA_DIR = self.tmp
        config.DEMO_PASSWORD = self.PASSWORD
        config.SHARED_SECRET = self.SECRET
        config.FAKE_PIPELINE = True
        config.WEB_MAX_UPLOAD_MB = 1
        config.WEB_MAX_JOBS_PER_HOUR = 50
        config.WEB_RETENTION_HOURS = 24
        config.KEEP_DISCORD_FLOW = False
        config.WEB_SESSION_KEY = None
        # generous limits so the ordinary tests are never throttled; the rate-limit tests lower them
        config.WEB_RATE_PER_MIN = config.WEB_RATE_GLOBAL_PER_MIN = 100000
        config.WEB_UPLOADS_PER_HOUR_PER_IP = 1000
        config.WEB_MAX_CONCURRENT_UPLOADS = 2
        web_ratelimit.reset()
        fake_pipeline.DELAY_S = 0.0
        store._CLIPS_DIR = store._CSV_PATH = None
        web_auth.limiter = web_auth.LoginLimiter()

        import main
        import web_api
        web_api.FAILURE_DELAY_S = 0
        self.main = main
        web_jobs.jobs.load()
        self.stop = web_jobs.start()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), main.Handler)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self):
        self.stop.set()
        self.server.shutdown()
        self.server.server_close()
        for key, value in self._saved.items():
            setattr(config, key, value)
        shutil.rmtree(self.tmp, ignore_errors=True)

    # ---- HTTP ----
    def request(self, method, path, body=None, headers=None, cookie=None, json_body=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        hdrs = dict(headers or {})
        if json_body is not None:
            body = json.dumps(json_body).encode()
            hdrs["Content-Type"] = "application/json"
        if cookie:
            hdrs["Cookie"] = cookie
        conn.request(method, path, body=body, headers=hdrs)
        res = conn.getresponse()
        data = res.read()
        out = {"status": res.status, "headers": {k.lower(): v for k, v in res.getheaders()}, "raw": data}
        try:
            out["json"] = json.loads(data)
        except Exception:
            out["json"] = None
        conn.close()
        return out

    def login(self):
        res = self.request("POST", "/api/login", json_body={"password": self.PASSWORD}, headers=CSRF)
        self.assertEqual(res["status"], 200, res)
        return res["headers"]["set-cookie"].split(";")[0]

    def upload(self, cookie, name="clip.mp4", data=b"x" * 5000, modalities="AU.T", cache_mode="d", extra=None):
        from urllib.parse import quote
        headers = {**CSRF, "X-Filename": quote(name), "X-Modalities": modalities, "X-Cache-Mode": cache_mode, **(extra or {})}
        return self.request("POST", "/api/upload", body=data, headers=headers, cookie=cookie)

    def wait_for(self, cookie, job_id, status="done", timeout=10):
        deadline = time.time() + timeout
        while time.time() < deadline:
            job = self.request("GET", f"/api/jobs/{job_id}", cookie=cookie)["json"]
            if job["status"] == status:
                return job
            time.sleep(0.05)
        self.fail(f"job {job_id} never reached {status}: {job}")
