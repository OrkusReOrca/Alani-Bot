"""Jobs for the web dashboard: what was uploaded, what is running, what came out.

Layout on this slot's own disk (config.DATA_DIR/web/):

  clips/<clip_id>/   input.<ext>, frames/frame_NNN.jpg, first_frame.jpg,
                     annotated.png — everything about one uploaded video that a
                     re-analysis can reuse. The per-modality cache JSON lives in
                     store.py under the key "web_<clip_id>".
  jobs/<job_id>/job.json   one analysis run of a clip (status, progress, result).

A clip can have several jobs: the first upload, then every "re-analyse with
other modalities" — they share the clip directory, so only what is missing is
recomputed. Jobs run one at a time on a single worker thread, and each holds
runtime.heavy_lock around the real work so nothing else on the slot (a Discord
run, a warm-up) overlaps with it.

job.json is written atomically (temp file + os.replace). After a restart any
job that was queued/running is marked "interrupted" — never silently dropped —
and the UI offers a Re-run button (the upload is still on disk).
"""

import json
import os
import queue
import shutil
import tempfile
import threading
import time
import traceback
import uuid
from collections import deque
from datetime import datetime, timezone

import config
import runtime
import store
from stages import ALL_MODALITIES

VIDEO_EXTS = (".mov", ".mp4", ".avi", ".mkv", ".webm")
ACTIVE = ("uploading", "queued", "running")
_FORBIDDEN_NAME_CHARS = '<>"|?*'


class JobError(Exception):
    """A request the user can fix; carries the HTTP status to answer with."""

    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _root():
    return os.path.join(config.DATA_DIR, "web")


def jobs_dir():
    return os.path.join(_root(), "jobs")


def clips_dir():
    return os.path.join(_root(), "clips")


def clip_dir(clip_id):
    return os.path.join(clips_dir(), clip_id)


def clip_cache_key(clip_id):
    return f"web_{clip_id}"


def normalize_modalities(value):
    """Validated, canonical-order list of modalities, or JobError."""
    if not isinstance(value, list) or not value or any(m not in ALL_MODALITIES for m in value):
        raise JobError(400, f"modalities must be a non-empty subset of {ALL_MODALITIES}")
    return [m for m in ALL_MODALITIES if m in value]


def sanitize_filename(name):
    """Display-only name: no path, no control characters, at most 120 chars."""
    base = os.path.basename((name or "").replace("\\", "/"))
    cleaned = "".join(ch for ch in base if ch.isprintable() and ch not in _FORBIDDEN_NAME_CHARS).strip()
    return (cleaned or "video")[:120]


class JobStore:
    def __init__(self):
        self._lock = threading.RLock()
        self._jobs = {}
        self._recent_creations = deque()
        self._queue = queue.Queue()

    # ---- persistence ----
    def _path(self, job_id):
        return os.path.join(jobs_dir(), job_id, "job.json")

    def _write(self, job):
        path = self._path(job["id"])
        os.makedirs(os.path.dirname(path), exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(job, f, ensure_ascii=False)
        os.replace(tmp, path)

    def load(self):
        """Read every job from disk; mark the ones a restart cut short."""
        with self._lock:
            self._jobs = {}
            self._recent_creations.clear()
            os.makedirs(jobs_dir(), exist_ok=True)
            for name in os.listdir(jobs_dir()):
                try:
                    with open(self._path(name), encoding="utf-8") as f:
                        job = json.load(f)
                except Exception:
                    continue
                if job.get("status") in ACTIVE:
                    job["status"] = "interrupted"
                    job["error"] = "The service restarted before this analysis finished. Press Re-run to analyse it again."
                    self._write(job)
                self._jobs[job["id"]] = job

    def update(self, job_id, **fields):
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return None
            job.update(fields)
            self._write(job)
            return job

    # ---- creation ----
    def _check_rate(self):
        now = time.time()
        while self._recent_creations and now - self._recent_creations[0] > 3600:
            self._recent_creations.popleft()
        if len(self._recent_creations) >= config.WEB_MAX_JOBS_PER_HOUR:
            raise JobError(429, f"That is the limit of {config.WEB_MAX_JOBS_PER_HOUR} analyses per hour. Try again a little later.")

    def check_can_create(self):
        with self._lock:
            self._check_rate()

    def create(self, *, clip_id, original_filename, size_bytes, modalities, cache_mode, parent_id=None, status="queued"):
        with self._lock:
            self._check_rate()
            job = {
                "id": uuid.uuid4().hex[:12],
                "clip_id": clip_id,
                "created_at": now_iso(),
                "original_filename": original_filename,
                "size_bytes": size_bytes,
                "status": status,
                "stage": "queued",
                "stage_detail": "",
                "progress": {"percent": 0, "status": {}, "timings": {}},
                "modalities": modalities,
                "cache_mode": cache_mode,
                "parent_id": parent_id,
                "pinned": False,
                "saved_at": None,
                "result": None,
                "error": None,
            }
            self._recent_creations.append(time.time())
            self._jobs[job["id"]] = job
            self._write(job)
            return job

    def enqueue(self, job_id):
        self.update(job_id, status="queued", stage="queued", stage_detail="Waiting for its turn")
        self._queue.put(job_id)

    def rerun(self, job_id, modalities):
        with self._lock:
            source = self._jobs.get(job_id)
            if source is None:
                raise JobError(404, "No such run")
            if not os.path.isdir(clip_dir(source["clip_id"])):
                raise JobError(410, "The uploaded video is no longer on the server")
            job = self.create(
                clip_id=source["clip_id"], original_filename=source["original_filename"], size_bytes=source["size_bytes"],
                modalities=modalities, cache_mode=source["cache_mode"], parent_id=job_id,
            )
        self.enqueue(job["id"])
        return job

    # ---- reading ----
    def get(self, job_id):
        with self._lock:
            return self._jobs.get(job_id)

    def listing(self):
        with self._lock:
            jobs = sorted(self._jobs.values(), key=lambda j: j["created_at"], reverse=True)
            return [self.summary(j) for j in jobs]

    @staticmethod
    def summary(job):
        result = job.get("result") or {}
        return {
            "id": job["id"], "clip_id": job["clip_id"], "created_at": job["created_at"],
            "original_filename": job["original_filename"], "status": job["status"], "stage": job["stage"],
            "modalities": job["modalities"], "prediction": result.get("prediction"), "short": result.get("short"),
            "total_seconds": result.get("total_seconds"), "pinned": job["pinned"], "saved": bool(job.get("saved_at")),
            "parent_id": job["parent_id"],
        }

    def view(self, job_id):
        """Full job + queue position + the other runs of the same clip."""
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return None
            out = dict(job)
            out["queue_position"] = self.queue_position(job_id)
            siblings = [j for j in self._jobs.values() if j["clip_id"] == job["clip_id"]]
            siblings.sort(key=lambda j: j["created_at"])
            out["runs"] = [self.summary(j) for j in siblings]
            return out

    def queue_position(self, job_id):
        """0 = running or next; n = n analyses ahead of it."""
        with self._lock:
            ahead = [j for j in self._jobs.values() if j["status"] in ("queued", "running")]
            ahead.sort(key=lambda j: j["created_at"])
            ids = [j["id"] for j in ahead]
            return ids.index(job_id) if job_id in ids else 0

    # ---- deleting ----
    def delete(self, job_id):
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                raise JobError(404, "No such run")
            if job["status"] in ACTIVE:
                raise JobError(409, "That run is still in progress")
            del self._jobs[job_id]
            shutil.rmtree(os.path.dirname(self._path(job_id)), ignore_errors=True)
            if not any(j["clip_id"] == job["clip_id"] for j in self._jobs.values()):
                shutil.rmtree(clip_dir(job["clip_id"]), ignore_errors=True)
                store.delete_clip(clip_cache_key(job["clip_id"]))

    def purge_expired(self, now=None):
        """Delete unpinned, finished runs older than the retention window.
        Uploaded face videos are personal data. Returns how many were removed."""
        cutoff = (now if now is not None else time.time()) - config.WEB_RETENTION_HOURS * 3600
        removed = 0
        with self._lock:
            old = [
                j["id"] for j in self._jobs.values()
                if not j["pinned"] and j["status"] not in ACTIVE and datetime.fromisoformat(j["created_at"]).timestamp() < cutoff
            ]
            for job_id in old:
                try:
                    self.delete(job_id)
                    removed += 1
                except JobError:
                    pass
        return removed

    # ---- the worker's inbox ----
    def next_id(self, timeout=1.0):
        try:
            return self._queue.get(timeout=timeout)
        except queue.Empty:
            return None


jobs = JobStore()


def input_path(clip_id):
    folder = clip_dir(clip_id)
    for name in os.listdir(folder) if os.path.isdir(folder) else []:
        if name.startswith("input."):
            return os.path.join(folder, name)
    return None


def _processor():
    if config.FAKE_PIPELINE:
        import fake_pipeline
        return fake_pipeline.process
    import core
    return core.process


def _jsonable_result(result):
    out = {k: v for k, v in result.items() if k not in ("files", "marks")}
    out["has_annotated"] = bool(result["files"].get("annotated"))
    out["has_first_frame"] = bool(result["files"].get("first_frame"))
    return out


def run_job(job_id, store_=None):
    """Run one job to completion (or failure). Never raises."""
    store_ = store_ or jobs
    job = store_.get(job_id)
    if job is None or job["status"] != "queued":
        return

    def progress(stage, detail=None, percent=None, status=None, timings=None):
        store_.update(
            job_id, stage=stage, stage_detail=detail or "",
            progress={"percent": percent or 0, "status": status or {}, "timings": timings or {}},
        )

    work_dir = tempfile.mkdtemp(prefix="emotion_web_")
    try:
        if not config.FAKE_PIPELINE and not config.OPENROUTER_API_KEY:
            raise RuntimeError("OPENROUTER_API_KEY is not set on the server, so the prediction step cannot run")
        src = input_path(job["clip_id"])
        if src is None:
            raise RuntimeError("The uploaded video is no longer on the server")
        store_.update(job_id, stage="queued", stage_detail="Waiting for any other analysis on this server to finish")
        with runtime.heavy_lock:
            store_.update(job_id, status="running", stage="truncating", stage_detail="Starting", started_at=now_iso())
            result = _processor()(
                clip_cache_key(job["clip_id"]), src, job["modalities"], job["cache_mode"], False, progress, work_dir,
                persist_dir=clip_dir(job["clip_id"]), render_annotated=True,
            )
        runtime.mark_ready()
        store_.update(
            job_id, status="done", stage="done", stage_detail="Finished", finished_at=now_iso(), result=_jsonable_result(result),
            progress={"percent": 100, "status": result["stage_status"], "timings": result["stage_timings"]},
        )
    except Exception as e:  # one bad job must never stop the worker
        traceback.print_exc()
        tail = "".join(traceback.format_exception_only(type(e), e)).strip()[-400:]
        store_.update(job_id, status="error", stage="error", stage_detail="", error=tail, finished_at=now_iso())
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


def worker_loop(stop_event, store_=None):
    store_ = store_ or jobs
    while not stop_event.is_set():
        job_id = store_.next_id()
        if job_id:
            run_job(job_id, store_)


def retention_loop(stop_event, store_=None, interval_s=3600):
    store_ = store_ or jobs
    while not stop_event.is_set():
        removed = store_.purge_expired()
        if removed:
            print(f"[web] retention removed {removed} old run(s)")
        stop_event.wait(interval_s)


def start(store_=None):
    """Load jobs from disk, then start the worker and the hourly clean-up.
    Interrupted jobs are not re-queued: they wait for the user's Re-run."""
    store_ = store_ or jobs
    store_.load()
    stop = threading.Event()
    threading.Thread(target=worker_loop, args=(stop, store_), daemon=True, name="web-worker").start()
    threading.Thread(target=retention_loop, args=(stop, store_), daemon=True, name="web-retention").start()
    return stop
