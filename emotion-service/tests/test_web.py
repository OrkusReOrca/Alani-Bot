"""The dashboard end to end over real HTTP, using the fake pipeline."""

import os
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from helpers import CSRF, WebTestCase  # noqa: E402

import config
import runtime
import web_auth
import web_jobs


class AuthTests(WebTestCase):
    def test_health_is_public_and_everything_else_needs_a_login(self):
        self.assertEqual(self.request("GET", "/api/health")["json"], {"ok": True})
        for path in ("/api/jobs", "/api/config", "/api/jobs/aaaaaaaaaaaa"):
            self.assertEqual(self.request("GET", path)["status"], 401, path)
        self.assertEqual(self.request("GET", "/api/session")["json"], {"authenticated": False})

    def test_wrong_password_then_lockout_with_retry_after(self):
        for _ in range(4):
            self.assertEqual(self.request("POST", "/api/login", json_body={"password": "nope"}, headers=CSRF)["status"], 401)
        fifth = self.request("POST", "/api/login", json_body={"password": "nope"}, headers=CSRF)
        self.assertEqual(fifth["status"], 429)
        self.assertIn("retry-after", fifth["headers"])
        # even the right password is refused while locked out
        self.assertEqual(self.request("POST", "/api/login", json_body={"password": self.PASSWORD}, headers=CSRF)["status"], 429)

    def test_login_sets_a_strict_httponly_cookie_and_works(self):
        res = self.request("POST", "/api/login", json_body={"password": self.PASSWORD}, headers=CSRF)
        cookie = res["headers"]["set-cookie"]
        self.assertIn("HttpOnly", cookie)
        self.assertIn("SameSite=Strict", cookie)
        self.assertNotIn("Secure", cookie)  # plain http in this test
        self.assertEqual(self.request("GET", "/api/session", cookie=cookie.split(";")[0])["json"], {"authenticated": True})

    def test_cookie_is_secure_behind_the_https_proxy(self):
        res = self.request("POST", "/api/login", json_body={"password": self.PASSWORD}, headers={**CSRF, "X-Forwarded-Proto": "https"})
        self.assertIn("Secure", res["headers"]["set-cookie"])

    def test_state_changing_requests_need_the_custom_header(self):
        res = self.request("POST", "/api/login", json_body={"password": self.PASSWORD})
        self.assertEqual(res["status"], 403)

    def test_tampered_cookie_is_rejected(self):
        cookie = self.login()
        name, _, value = cookie.partition("=")
        payload, _, sig = value.partition(".")
        self.assertEqual(self.request("GET", "/api/jobs", cookie=f"{name}={payload}.{sig[:-2]}xx")["status"], 401)
        self.assertEqual(self.request("GET", "/api/jobs", cookie=f"{name}=garbage")["status"], 401)

    def test_old_bearer_routes_are_independent_of_the_cookie(self):
        cookie = self.login()
        self.assertEqual(self.request("POST", "/run", cookie=cookie, json_body={})["status"], 401)  # cookie never opens /run
        self.assertEqual(self.request("POST", "/resend", cookie=cookie, json_body={})["status"], 401)

    def test_discord_flow_is_off_while_the_dashboard_is_on(self):
        res = self.request("POST", "/run", headers={"Authorization": f"Bearer {self.SECRET}"}, json_body={"runMode": "run1"})
        self.assertEqual(res["status"], 503)
        self.assertIn("web dashboard", res["json"]["error"])

    def test_static_page_is_public_and_traversal_is_blocked(self):
        self.assertEqual(self.request("GET", "/app/")["status"], 200)
        self.assertEqual(self.request("GET", "/app/app.js")["status"], 200)
        for bad in ("/app/../config.py", "/app/%2e%2e/config.py", "/app/..%2fconfig.py", "/app/.env"):
            self.assertEqual(self.request("GET", bad)["status"], 404, bad)

    def test_dashboard_is_disabled_without_a_password(self):
        config.DEMO_PASSWORD = None
        self.assertEqual(self.request("GET", "/app/")["status"], 404)
        self.assertEqual(self.request("GET", "/api/health")["status"], 404)
        # and the old flow answers again (401 without the bearer secret, as before)
        self.assertEqual(self.request("POST", "/run", json_body={})["status"], 401)


class UploadAndJobTests(WebTestCase):
    def test_upload_runs_to_done_with_progress_and_a_result(self):
        cookie = self.login()
        res = self.upload(cookie)
        self.assertEqual(res["status"], 201, res)
        job = self.wait_for(cookie, res["json"]["jobId"])
        self.assertEqual(job["result"]["short"], "PA")
        self.assertEqual(job["progress"]["percent"], 100)
        self.assertIn("face", job["result"]["stage_timings"])
        self.assertEqual(job["original_filename"], "clip.mp4")

    def test_upload_rules(self):
        cookie = self.login()
        self.assertEqual(self.upload(cookie, name="malware.exe")["status"], 415)
        self.assertEqual(self.upload(cookie, data=b"x" * (2 * 1024 * 1024))["status"], 413)  # limit is 1 MB here
        self.assertEqual(self.upload(cookie, modalities="XX")["status"], 400)
        self.assertEqual(self.upload(cookie, cache_mode="z")["status"], 400)
        self.assertEqual(self.upload(None)["status"], 401)
        self.assertEqual(self.request("GET", "/api/jobs", cookie=cookie)["json"]["jobs"], [])  # nothing was created

    def test_filename_is_sanitised_and_never_used_as_a_path(self):
        cookie = self.login()
        res = self.upload(cookie, name="..\..\evil<name>.mp4")
        job = self.wait_for(cookie, res["json"]["jobId"])
        self.assertEqual(job["original_filename"], "evilname.mp4")
        self.assertTrue(os.path.isfile(os.path.join(web_jobs.clip_dir(job["clip_id"]), "input.mp4")))  # on disk it is always input.<ext>

    def test_short_body_is_rejected_and_leaves_nothing_behind(self):
        import http.client
        cookie = self.login()
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.putrequest("POST", "/api/upload")
        for k, v in {**CSRF, "X-Filename": "a.mp4", "X-Modalities": "AU", "Content-Length": "5000", "Cookie": cookie}.items():
            conn.putheader(k, v)
        conn.endheaders()
        conn.send(b"only a little")
        conn.sock.shutdown(1)  # half-close: the server sees a short body
        res = conn.getresponse()
        self.assertEqual(res.status, 400)
        conn.close()
        self.assertEqual(os.listdir(web_jobs.clips_dir()), [])

    def test_rerun_reuses_the_cache_and_lists_both_runs(self):
        cookie = self.login()
        first = self.wait_for(cookie, self.upload(cookie, modalities="AU.T.VO.ET.HT")["json"]["jobId"])
        res = self.request("POST", f"/api/jobs/{first['id']}/rerun", json_body={"modalities": ["T"]}, headers=CSRF, cookie=cookie)
        self.assertEqual(res["status"], 201)
        second = self.wait_for(cookie, res["json"]["jobId"])
        self.assertEqual(second["result"]["short"], "ND")
        self.assertEqual(second["parent_id"], first["id"])
        status = second["result"]["stage_status"]
        self.assertEqual(status["face"], "cached")
        self.assertEqual(status["transcript"], "cached")
        self.assertEqual({r["id"] for r in second["runs"]}, {first["id"], second["id"]})
        self.assertEqual(self.request("POST", f"/api/jobs/{first['id']}/rerun", json_body={"modalities": []}, headers=CSRF, cookie=cookie)["status"], 400)

    def test_media_route_serves_allowed_files_only(self):
        cookie = self.login()
        job = self.wait_for(cookie, self.upload(cookie)["json"]["jobId"])
        base = f"/api/jobs/{job['id']}/media/"
        self.assertEqual(self.request("GET", base + "annotated.png", cookie=cookie)["status"], 200)
        self.assertEqual(self.request("GET", base + "frames/frame_000.jpg", cookie=cookie)["status"], 200)
        self.assertEqual(self.request("GET", base + "input", cookie=cookie)["status"], 200)
        self.assertEqual(self.request("GET", base + "annotated.png")["status"], 401)
        for bad in ("../job.json", "..%2fjob.json", "%2e%2e/%2e%2e/job.json", "frames/../../job.json", "frames/frame_000.jpg/..", "/etc/passwd",
                    "frames/frame_00.jpg", "input.mp4", "job.json"):
            self.assertEqual(self.request("GET", base + bad, cookie=cookie)["status"], 404, bad)
        partial = self.request("GET", base + "input", headers={"Range": "bytes=0-99"}, cookie=cookie)
        self.assertEqual((partial["status"], len(partial["raw"])), (206, 100))

    def test_pin_delete_and_running_jobs_cannot_be_deleted(self):
        cookie = self.login()
        job = self.wait_for(cookie, self.upload(cookie)["json"]["jobId"])
        self.assertEqual(self.request("POST", f"/api/jobs/{job['id']}/pin", json_body={"pinned": True}, headers=CSRF, cookie=cookie)["status"], 200)
        self.assertTrue(self.request("GET", f"/api/jobs/{job['id']}", cookie=cookie)["json"]["pinned"])
        self.assertEqual(self.request("DELETE", f"/api/jobs/{job['id']}", headers=CSRF, cookie=cookie)["status"], 200)
        self.assertEqual(self.request("GET", f"/api/jobs/{job['id']}", cookie=cookie)["status"], 404)
        self.assertEqual(os.listdir(web_jobs.clips_dir()), [])  # the video went with its last run
        self.assertEqual(self.request("DELETE", "/api/jobs/aaaaaaaaaaaa", headers=CSRF, cookie=cookie)["status"], 404)

    def test_per_hour_cap(self):
        cookie = self.login()
        config.WEB_MAX_JOBS_PER_HOUR = 2
        for _ in range(2):
            self.assertEqual(self.upload(cookie)["status"], 201)
        self.assertEqual(self.upload(cookie)["status"], 429)

    def test_discord_and_web_never_run_together(self):
        cookie = self.login()
        with runtime.heavy_lock:  # a Discord-style analysis is "running"
            res = self.upload(cookie)
            job_id = res["json"]["jobId"]
            time.sleep(0.4)
            job = self.request("GET", f"/api/jobs/{job_id}", cookie=cookie)["json"]
            self.assertEqual(job["status"], "queued")
            self.assertIn("Waiting", job["stage_detail"])
        self.assertEqual(self.wait_for(cookie, job_id)["status"], "done")

    def test_a_failing_job_reports_the_error_and_the_worker_survives(self):
        from unittest import mock

        def boom(*args, **kwargs):
            raise RuntimeError("the video could not be read")

        cookie = self.login()
        with mock.patch.object(web_jobs, "_processor", lambda: boom):
            failed = self.wait_for(cookie, self.upload(cookie)["json"]["jobId"], status="error")
        self.assertIn("could not be read", failed["error"])
        self.assertEqual(self.wait_for(cookie, self.upload(cookie)["json"]["jobId"])["status"], "done")

    def test_auto_retry_waits_out_a_busy_provider_and_a_plain_failure_keeps_its_timings(self):
        import fake_pipeline
        cookie = self.login()
        try:
            # without auto retry: the run fails with a readable sentence, and the finished steps keep their times
            fake_pipeline.FAIL_MODEL_CALLS = 1
            failed = self.wait_for(cookie, self.upload(cookie, modalities="AU.T", extra={"X-Auto-Retry": "0"})["json"]["jobId"], status="error")
            self.assertIn("rate-limited", failed["error"])
            self.assertNotIn("{", failed["error"])
            self.assertFalse(failed["auto_retry"])
            self.assertEqual(failed["progress"]["status"]["face"], "done")
            self.assertIn("face", failed["progress"]["timings"])

            # re-running it does not redo the finished steps and reports what they took
            res = self.request("POST", f"/api/jobs/{failed['id']}/rerun", json_body={"modalities": ["AU", "T"]}, headers=CSRF, cookie=cookie)
            rerun = self.wait_for(cookie, res["json"]["jobId"])
            self.assertEqual(rerun["result"]["stage_status"]["face"], "cached")
            self.assertEqual(rerun["result"]["stage_cached_seconds"]["face"], failed["progress"]["timings"]["face"])
            self.assertEqual(set(rerun["result"]["stage_timings"]), {"vlm_valence", "vlm_arousal"})
            self.assertGreater(rerun["runs"][-1]["reused_seconds"], 0)

            # with auto retry: it just keeps going until the provider answers
            fake_pipeline.FAIL_MODEL_CALLS = 3
            done = self.wait_for(cookie, self.upload(cookie, extra={"X-Auto-Retry": "1"})["json"]["jobId"])
            self.assertTrue(done["auto_retry"])
            self.assertEqual(fake_pipeline.FAIL_MODEL_CALLS, 0)
        finally:
            fake_pipeline.FAIL_MODEL_CALLS = 0

    def test_a_rerun_inherits_auto_retry_unless_told_otherwise(self):
        cookie = self.login()
        first = self.wait_for(cookie, self.upload(cookie, extra={"X-Auto-Retry": "1"})["json"]["jobId"])
        inherited = self.request("POST", f"/api/jobs/{first['id']}/rerun", json_body={"modalities": ["AU"]}, headers=CSRF, cookie=cookie)
        self.assertTrue(self.wait_for(cookie, inherited["json"]["jobId"])["auto_retry"])
        off = self.request("POST", f"/api/jobs/{first['id']}/rerun", json_body={"modalities": ["AU"], "autoRetry": False}, headers=CSRF, cookie=cookie)
        self.assertFalse(self.wait_for(cookie, off["json"]["jobId"])["auto_retry"])

    def test_warmup_reports_state(self):
        cookie = self.login()
        runtime._set_warm("cold")
        res = self.request("POST", "/api/warmup", headers=CSRF, cookie=cookie)
        self.assertEqual(res["status"], 202)
        deadline = time.time() + 5
        while time.time() < deadline and runtime.warm_state()["state"] != "ready":
            time.sleep(0.05)
        self.assertEqual(self.request("GET", "/api/status", cookie=cookie)["json"]["models"]["state"], "ready")

    def test_save_to_discord_posts_everything_and_marks_the_job(self):
        import callback
        sent = {}
        original = callback.post_web_save
        callback.post_web_save = lambda payload: (sent.update(payload) or True, "posted")
        try:
            cookie = self.login()
            job = self.wait_for(cookie, self.upload(cookie)["json"]["jobId"])
            self.assertEqual(self.request("POST", f"/api/jobs/{job['id']}/save", headers=CSRF, cookie=cookie)["status"], 200)
        finally:
            callback.post_web_save = original
        for key in ("fileName", "prediction", "modalities", "timings", "transcript", "valencePrompt", "arousalPrompt", "imageBase64"):
            self.assertIn(key, sent)
        self.assertEqual(sent["prediction"], "Positive_Activate (PA)")
        self.assertTrue(self.request("GET", f"/api/jobs/{job['id']}", cookie=cookie)["json"]["saved_at"])

    def test_save_failure_is_reported(self):
        import callback
        original = callback.post_web_save
        callback.post_web_save = lambda payload: (False, "Alani-Bot did not answer")
        try:
            cookie = self.login()
            job = self.wait_for(cookie, self.upload(cookie)["json"]["jobId"])
            res = self.request("POST", f"/api/jobs/{job['id']}/save", headers=CSRF, cookie=cookie)
        finally:
            callback.post_web_save = original
        self.assertEqual(res["status"], 502)


class RestartAndRetentionTests(WebTestCase):
    def test_interrupted_jobs_are_marked_never_dropped(self):
        cookie = self.login()
        finished = self.wait_for(cookie, self.upload(cookie)["json"]["jobId"])
        web_jobs.jobs.update(finished["id"], status="running")  # as if the service died mid-analysis
        web_jobs.jobs.load()  # what a restart does
        job = self.request("GET", f"/api/jobs/{finished['id']}", cookie=cookie)["json"]
        self.assertEqual(job["status"], "interrupted")
        self.assertIn("restarted", job["error"])
        res = self.request("POST", f"/api/jobs/{finished['id']}/rerun", json_body={"modalities": ["AU"]}, headers=CSRF, cookie=cookie)
        self.assertEqual(self.wait_for(cookie, res["json"]["jobId"])["status"], "done")

    def test_retention_deletes_old_unpinned_runs_only(self):
        cookie = self.login()
        old = self.wait_for(cookie, self.upload(cookie)["json"]["jobId"])
        pinned = self.wait_for(cookie, self.upload(cookie)["json"]["jobId"])
        fresh = self.wait_for(cookie, self.upload(cookie)["json"]["jobId"])
        web_jobs.jobs.update(pinned["id"], pinned=True)
        long_ago = "2020-01-01T00:00:00+00:00"
        web_jobs.jobs.update(old["id"], created_at=long_ago)
        web_jobs.jobs.update(pinned["id"], created_at=long_ago)
        self.assertEqual(web_jobs.jobs.purge_expired(), 1)
        self.assertIsNone(web_jobs.jobs.get(old["id"]))
        self.assertIsNotNone(web_jobs.jobs.get(pinned["id"]))
        self.assertIsNotNone(web_jobs.jobs.get(fresh["id"]))


class AuthUnitTests(unittest.TestCase):
    def setUp(self):
        self._saved = (config.DEMO_PASSWORD, config.WEB_SESSION_KEY, config.SHARED_SECRET, config.WEB_SESSION_HOURS)
        config.DEMO_PASSWORD, config.WEB_SESSION_KEY, config.SHARED_SECRET, config.WEB_SESSION_HOURS = "pw", None, "sec", 1

    def tearDown(self):
        config.DEMO_PASSWORD, config.WEB_SESSION_KEY, config.SHARED_SECRET, config.WEB_SESSION_HOURS = self._saved

    def test_session_expiry_and_key_change(self):
        token = web_auth.make_session(now=1000)
        self.assertTrue(web_auth.verify_session(token, now=1000 + 3599))
        self.assertFalse(web_auth.verify_session(token, now=1000 + 3601))
        config.DEMO_PASSWORD = "other"  # changing the password logs everybody out
        self.assertFalse(web_auth.verify_session(token, now=1001))

    def test_limiter_window(self):
        clock = [0.0]
        limiter = web_auth.LoginLimiter(clock=lambda: clock[0])
        for _ in range(5):
            limiter.record_failure("1.2.3.4")
        self.assertGreater(limiter.retry_after("1.2.3.4"), 0)
        self.assertEqual(limiter.retry_after("5.6.7.8"), 0)
        clock[0] = 61
        self.assertEqual(limiter.retry_after("1.2.3.4"), 0)

    def test_client_ip_only_trusts_the_header_behind_a_private_proxy(self):
        self.assertEqual(web_auth.client_ip("10.0.0.5", "203.0.113.9, 198.51.100.7"), "198.51.100.7")
        self.assertEqual(web_auth.client_ip("8.8.4.4", "1.1.1.1"), "8.8.4.4")  # a public peer could be lying
        self.assertEqual(web_auth.client_ip("10.0.0.5", None), "10.0.0.5")


if __name__ == "__main__":
    unittest.main()
