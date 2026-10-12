"""HTTP routes of the web dashboard: the static page, the JSON API, uploads and
the (authenticated) media route. main.py hands every GET/POST/DELETE that is not
the old bearer-secret flow to `handle()` here.

Everything except GET / , /app/*, /api/health, /api/session, /api/login needs
the signed session cookie (web_auth.py). The old POST /run and /resend never
read that cookie — they keep their own bearer-secret check in main.py.

Uploads are the raw file as the request body (no multipart, so no `cgi`, which
Python 3.13 removed): the browser sends `X-Filename`, `X-Modalities`,
`X-Cache-Mode` headers, we stream Content-Length bytes to disk in 1 MiB chunks.
"""

import base64
import json
import mimetypes
import os
import re
import shutil
import tempfile
import time
import uuid
from urllib.parse import unquote, urlsplit

import config
import runtime
import web_auth
import web_jobs
from stages import ALL_MODALITIES
from web_jobs import JobError, jobs

WEB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")
CHUNK = 1024 * 1024
FAILURE_DELAY_S = 0.5
MODEL_NAME = "Qwen3-VL-8B-Instruct"

_JOB_ID = re.compile(r"^[0-9a-f]{12}$")
_MEDIA_NAME = re.compile(r"^(annotated\.png|first_frame\.jpg|frames/frame_\d{3}\.jpg|input)$")
_STATIC_NAME = re.compile(r"^[A-Za-z0-9_.-]+$")
_STATIC_TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml"}

_CSP = (
    "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; "
    "style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"
)


# ---------- small response helpers ----------

def _secure(h):
    return (h.headers.get("X-Forwarded-Proto", "") or "").split(",")[0].strip().lower() == "https"


def _send(h, status, body, content_type, extra=None, head_only=False):
    h.send_response(status)
    h.send_header("Content-Type", content_type)
    h.send_header("Content-Length", str(len(body)))
    h.send_header("X-Content-Type-Options", "nosniff")
    h.send_header("Referrer-Policy", "no-referrer")
    h.send_header("Cache-Control", "no-store")
    for name, value in (extra or {}).items():
        h.send_header(name, value)
    h.end_headers()
    if not head_only:
        h.wfile.write(body)


def _json(h, status, body, extra=None):
    _send(h, status, json.dumps(body).encode("utf-8"), "application/json", extra)


def _error(h, status, message, extra=None):
    _json(h, status, {"error": message}, extra)


def _redirect(h, location):
    h.send_response(302)
    h.send_header("Location", location)
    h.send_header("Content-Length", "0")
    h.end_headers()


def _read_json(h):
    length = int(h.headers.get("Content-Length", 0) or 0)
    if length > 64 * 1024:
        raise JobError(413, "Request body too large")
    try:
        data = json.loads(h.rfile.read(length) or b"{}")
    except Exception:
        raise JobError(400, "Invalid JSON body")
    if not isinstance(data, dict):
        raise JobError(400, "Invalid JSON body")
    return data


# ---------- auth ----------

def _authed(h):
    return web_auth.verify_session(web_auth.token_from_cookie_header(h.headers.get("Cookie")))


def _csrf_ok(h):
    return h.headers.get(web_auth.CSRF_HEADER) == web_auth.CSRF_VALUE


def _login(h):
    ip = web_auth.client_ip(h.client_address[0], h.headers.get("X-Forwarded-For"))
    wait = web_auth.limiter.retry_after(ip)
    if wait:
        return _error(h, 429, f"Too many wrong passwords. Try again in {wait} seconds.", {"Retry-After": str(wait)})
    body = _read_json(h)
    if web_auth.check_password(body.get("password")):
        web_auth.limiter.record_success(ip)
        return _json(h, 200, {"ok": True}, {"Set-Cookie": web_auth.cookie_header(web_auth.make_session(), _secure(h))})
    web_auth.limiter.record_failure(ip)
    time.sleep(FAILURE_DELAY_S)  # slows down guessing even before the lock-out kicks in
    wait = web_auth.limiter.retry_after(ip)
    if wait:
        return _error(h, 429, f"Too many wrong passwords. Try again in {wait} seconds.", {"Retry-After": str(wait)})
    _error(h, 401, "Wrong password")


# ---------- static files ----------

def _serve_static(h, name, head_only=False):
    name = name or "index.html"
    if not _STATIC_NAME.match(name) or name.startswith("."):
        return _error(h, 404, "Not found")
    path = os.path.join(WEB_DIR, name)
    if not os.path.isfile(path):
        return _error(h, 404, "Not found")
    with open(path, "rb") as f:
        body = f.read()
    # Explicit types: with nosniff a wrong guess (platform mime tables differ) would stop the script or style from loading.
    content_type = _STATIC_TYPES.get(os.path.splitext(name)[1]) or mimetypes.guess_type(name)[0] or "application/octet-stream"
    extra = {"Content-Security-Policy": _CSP} if name.endswith(".html") else {}
    _send(h, 200, body, content_type, extra, head_only)


# ---------- media (authenticated, allow-listed) ----------

def _serve_media(h, job_id, name):
    job = jobs.get(job_id) if _JOB_ID.match(job_id) else None
    if job is None or not _MEDIA_NAME.match(name):
        return _error(h, 404, "Not found")
    folder = os.path.realpath(web_jobs.clip_dir(job["clip_id"]))
    path = web_jobs.input_path(job["clip_id"]) if name == "input" else os.path.join(folder, *name.split("/"))
    path = os.path.realpath(path) if path else None
    if not path or not path.startswith(folder + os.sep) or not os.path.isfile(path):
        return _error(h, 404, "Not found")
    size = os.path.getsize(path)
    content_type = mimetypes.guess_type(path)[0] or "application/octet-stream"
    start, end, status = 0, size - 1, 200
    match = re.match(r"^bytes=(\d*)-(\d*)$", h.headers.get("Range", "") or "")
    if match and (match.group(1) or match.group(2)):
        if match.group(1):
            start = int(match.group(1))
            end = int(match.group(2)) if match.group(2) else size - 1
        else:
            start = max(0, size - int(match.group(2)))
        end = min(end, size - 1)
        if start > end:
            return _error(h, 416, "Range not satisfiable", {"Content-Range": f"bytes */{size}"})
        status = 206
    h.send_response(status)
    h.send_header("Content-Type", content_type)
    h.send_header("Content-Length", str(end - start + 1))
    h.send_header("Accept-Ranges", "bytes")
    h.send_header("X-Content-Type-Options", "nosniff")
    h.send_header("Cache-Control", "private, max-age=300")
    if status == 206:
        h.send_header("Content-Range", f"bytes {start}-{end}/{size}")
    h.end_headers()
    with open(path, "rb") as f:
        f.seek(start)
        remaining = end - start + 1
        while remaining > 0:
            chunk = f.read(min(CHUNK, remaining))
            if not chunk:
                break
            h.wfile.write(chunk)
            remaining -= len(chunk)


# ---------- upload ----------

def _upload(h):
    try:
        length = int(h.headers.get("Content-Length", ""))
    except ValueError:
        raise JobError(411, "Content-Length is required")
    limit = int(config.WEB_MAX_UPLOAD_MB * 1024 * 1024)
    if length <= 0:
        raise JobError(400, "The upload is empty")
    if length > limit:
        raise JobError(413, f"That file is larger than the {config.WEB_MAX_UPLOAD_MB:g} MB limit")

    filename = web_jobs.sanitize_filename(unquote(h.headers.get("X-Filename", "") or ""))
    ext = os.path.splitext(filename)[1].lower()
    if ext not in web_jobs.VIDEO_EXTS:
        raise JobError(415, "Unsupported video type. Use " + ", ".join(web_jobs.VIDEO_EXTS))
    modalities = web_jobs.normalize_modalities([m for m in (h.headers.get("X-Modalities", "") or "").split(".") if m])
    cache_mode = (h.headers.get("X-Cache-Mode", "d") or "d").lower()
    if cache_mode not in ("d", "s"):
        raise JobError(400, "X-Cache-Mode must be d or s")

    auto_retry = (h.headers.get("X-Auto-Retry", "") or "").strip() == "1"
    jobs.check_can_create()
    os.makedirs(web_jobs.clips_dir(), exist_ok=True)
    free = shutil.disk_usage(web_jobs.clips_dir()).free
    if free < 2 * length:
        raise JobError(507, "Not enough free disk space on the server for this upload")

    clip_id = uuid.uuid4().hex[:12]
    folder = web_jobs.clip_dir(clip_id)
    os.makedirs(folder)
    try:
        received = 0
        with open(os.path.join(folder, "input" + ext), "wb") as out:
            while received < length:
                chunk = h.rfile.read(min(CHUNK, length - received))
                if not chunk:
                    break
                out.write(chunk)
                received += len(chunk)
        if received != length:
            raise JobError(400, "The upload was cut short")
        job = jobs.create(clip_id=clip_id, original_filename=filename, size_bytes=length, modalities=modalities, cache_mode=cache_mode, auto_retry=auto_retry)
    except Exception:
        shutil.rmtree(folder, ignore_errors=True)
        raise
    jobs.enqueue(job["id"])
    _json(h, 201, {"jobId": job["id"], "queuePosition": jobs.queue_position(job["id"])})


# ---------- save to Discord ----------

def _image_for_discord(job):
    """The annotated frame (else the plain first frame), shrunk so the base64 body
    never threatens the small Node container (see video.make_thumbnail)."""
    folder = web_jobs.clip_dir(job["clip_id"])
    for name in ("annotated.png", "first_frame.jpg"):
        path = os.path.join(folder, name)
        if not os.path.isfile(path):
            continue
        try:
            import video
            out = os.path.join(tempfile.mkdtemp(prefix="emotion_save_"), "image.jpg")
            small = video.make_thumbnail(path, out, max_dim=1400, quality=85)
            if small:
                with open(small, "rb") as f:
                    data = f.read()
                shutil.rmtree(os.path.dirname(out), ignore_errors=True)
                return data, "result.jpg"
        except Exception:
            pass
        if os.path.getsize(path) < 3 * 1024 * 1024:
            with open(path, "rb") as f:
                return f.read(), name
    return None, None


def _save_to_discord(h, job):
    if job["status"] != "done" or not job.get("result"):
        raise JobError(409, "Only a finished run can be saved")
    import callback
    result = job["result"]
    image, image_name = _image_for_discord(job)
    payload = {
        "fileName": job["original_filename"],
        "prediction": f"{result['prediction']} ({result['short']})",
        "modalities": job["modalities"],
        "cacheMode": job["cache_mode"],
        "timings": {**result["stage_timings"], "total": result["total_seconds"]},
        "clipSeconds": result.get("clip_seconds"),
        "truncated": bool(result.get("truncated")),
        "transcript": result.get("transcript", ""),
        "valenceRaw": result.get("valence_raw", ""),
        "arousalRaw": result.get("arousal_raw", ""),
        "valencePrompt": result.get("valence_prompt", ""),
        "arousalPrompt": result.get("arousal_prompt", ""),
    }
    if image:
        payload["imageBase64"] = base64.b64encode(image).decode("ascii")
        payload["imageName"] = image_name
    ok, message = callback.post_web_save(payload)
    if not ok:
        raise JobError(502, message)
    jobs.update(job["id"], saved_at=web_jobs.now_iso())
    _json(h, 200, {"ok": True})


# ---------- warm-up ----------

def _warm_loader():
    if config.FAKE_PIPELINE:
        import fake_pipeline
        return fake_pipeline.warm_up()
    import detector
    import extract_transcript
    import extract_voice
    detector._get_detector()
    extract_transcript._get_model()
    extract_voice._get_smile()


def start_warm_up():
    return runtime.warm_up(_warm_loader)


# ---------- routing ----------

def _job_or_404(job_id):
    job = jobs.get(job_id) if _JOB_ID.match(job_id) else None
    if job is None:
        raise JobError(404, "No such run")
    return job


def _status_body():
    return {"models": runtime.warm_state()}


def _config_body():
    return {
        "maxUploadMb": config.WEB_MAX_UPLOAD_MB,
        "maxClipSeconds": config.MAX_CLIP_SECONDS,
        "retentionHours": config.WEB_RETENTION_HOURS,
        "modalities": ALL_MODALITIES,
        "modelName": MODEL_NAME,
        "demo": bool(config.FAKE_PIPELINE),
        **_status_body(),
    }


def handle(h, method):
    """Returns True if the request belonged to the dashboard (and was answered)."""
    if not web_auth.enabled():
        return False
    parts = urlsplit(h.path)
    path = parts.path

    if path in ("/", "/app"):
        if method not in ("GET", "HEAD"):
            return False
        _redirect(h, "/app/")
        return True
    if path.startswith("/app/"):
        if method not in ("GET", "HEAD"):
            return False
        _serve_static(h, path[len("/app/"):], head_only=(method == "HEAD"))
        return True
    if not path.startswith("/api/"):
        return False

    try:
        _route_api(h, method, path)
    except JobError as e:
        _error(h, e.status, e.message)
    except Exception as e:  # never leak internals (or secrets) to the browser
        import traceback
        traceback.print_exc()
        _error(h, 500, "Something went wrong on the server")
    return True


def _route_api(h, method, path):
    if method in ("POST", "DELETE") and not _csrf_ok(h):
        raise JobError(403, "Missing request header")

    if path == "/api/health" and method == "GET":
        return _json(h, 200, {"ok": True})
    if path == "/api/session" and method == "GET":
        return _json(h, 200, {"authenticated": _authed(h)})
    if path == "/api/login" and method == "POST":
        return _login(h)

    if not _authed(h):
        raise JobError(401, "Please log in")

    if path == "/api/logout" and method == "POST":
        return _json(h, 200, {"ok": True}, {"Set-Cookie": web_auth.clear_cookie_header(_secure(h))})
    if path == "/api/config" and method == "GET":
        return _json(h, 200, _config_body())
    if path == "/api/status" and method == "GET":
        return _json(h, 200, _status_body())
    if path == "/api/warmup" and method == "POST":
        started = start_warm_up()
        return _json(h, 202, {"started": started, **_status_body()})
    if path == "/api/upload" and method == "POST":
        return _upload(h)
    if path == "/api/jobs" and method == "GET":
        return _json(h, 200, {"jobs": jobs.listing()})

    segments = path.split("/")  # ['', 'api', 'jobs', id, ...]
    if len(segments) >= 4 and segments[2] == "jobs":
        job_id = segments[3]
        job = _job_or_404(job_id)
        rest = segments[4:]
        if not rest and method == "GET":
            return _json(h, 200, jobs.view(job_id))
        if not rest and method == "DELETE":
            jobs.delete(job_id)
            return _json(h, 200, {"ok": True})
        if rest == ["rerun"] and method == "POST":
            body = _read_json(h)
            auto_retry = body.get("autoRetry")
            new = jobs.rerun(job_id, web_jobs.normalize_modalities(body.get("modalities")), None if auto_retry is None else bool(auto_retry))
            return _json(h, 201, {"jobId": new["id"]})
        if rest == ["pin"] and method == "POST":
            jobs.update(job_id, pinned=bool(_read_json(h).get("pinned")))
            return _json(h, 200, {"ok": True})
        if rest == ["save"] and method == "POST":
            return _save_to_discord(h, job)
        if len(rest) >= 2 and rest[0] == "media" and method == "GET":
            return _serve_media(h, job_id, "/".join(rest[1:]))

    raise JobError(404, "Not found")
