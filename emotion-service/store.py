"""All persistent state for this feature lives here, on this
deployment's own disk — per the plan, nothing about emotion predictions
goes into Alani-Bot's SQLite.

- One JSON per clip (keyed by Drive fileId, not filename, since a
  filename changes the moment a clip is marked done) — holds every
  cached modality string/value plus both raw VLM responses and the
  final prediction.
- One single append-only CSV — every row is one clip touched by one
  invocation. The latest row per file_id is that clip's current status;
  the full set of rows is the call history. One file serves both, per
  the user's literal "maintain one csv" instruction.
"""

import csv
import json
import os
import shutil
from datetime import datetime, timedelta, timezone

import config

_CLIPS_DIR = None
_CSV_PATH = None
_CSV_FIELDS = [
    "timestamp", "file_id", "filename", "invoked_by", "run_mode",
    "modalities", "cache_mode", "status", "prediction", "valence_raw",
    "arousal_raw", "error",
]


def _paths():
    global _CLIPS_DIR, _CSV_PATH
    if _CLIPS_DIR is None:
        _CLIPS_DIR = os.path.join(config.DATA_DIR, "clips")
        _CSV_PATH = os.path.join(config.DATA_DIR, "clips_log.csv")
        os.makedirs(_CLIPS_DIR, exist_ok=True)
    return _CLIPS_DIR, _CSV_PATH


def _clip_json_path(file_id):
    clips_dir, _ = _paths()
    return os.path.join(clips_dir, f"{file_id}.json")


def _first_frame_path(file_id):
    clips_dir, _ = _paths()
    return os.path.join(clips_dir, f"{file_id}.jpg")


def save_first_frame(file_id, src_path):
    """Copies the clip's first frame out of its (temporary, deleted right
    after processing) work directory into durable per-clip storage, so
    "resend" can reattach it later without redoing any extraction. No-op
    if there's no frame to save (e.g. extraction failed before any frame
    existed)."""
    if not src_path or not os.path.exists(src_path):
        return
    shutil.copyfile(src_path, _first_frame_path(file_id))


def load_first_frame(file_id):
    """Returns the persisted first-frame path, or None if this clip was
    never successfully processed (or predates this feature)."""
    path = _first_frame_path(file_id)
    return path if os.path.exists(path) else None


def load_clip_cache(file_id):
    path = _clip_json_path(file_id)
    if not os.path.exists(path):
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def save_clip_cache(file_id, data):
    with open(_clip_json_path(file_id), "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def append_log_row(*, file_id, filename, invoked_by, run_mode, modalities, cache_mode, status, prediction="", valence_raw="", arousal_raw="", error=""):
    _, csv_path = _paths()
    row = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "file_id": file_id,
        "filename": filename,
        "invoked_by": invoked_by,
        "run_mode": run_mode,
        "modalities": "+".join(modalities),
        "cache_mode": cache_mode,
        "status": status,
        "prediction": prediction,
        "valence_raw": valence_raw,
        "arousal_raw": arousal_raw,
        "error": error,
    }
    file_exists = os.path.exists(csv_path)
    with open(csv_path, "a", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=_CSV_FIELDS, extrasaction="ignore")
        if not file_exists:
            writer.writeheader()
        writer.writerow(row)


def _read_all_rows():
    _, csv_path = _paths()
    if not os.path.exists(csv_path):
        return []
    with open(csv_path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def latest_status_per_clip():
    """Every clip this deployment has ever touched, collapsed to its most
    recent row (by file_id) — the CSV is append-only, so this is what
    "current status of clip X" actually means. Used by the resend
    command's own selection logic below."""
    latest = {}
    for row in _read_all_rows():
        file_id = row.get("file_id")
        if not file_id:
            continue
        # Rows are appended in chronological order, so the last one seen
        # per file_id is the latest — no need to compare timestamps.
        latest[file_id] = row
    return latest


def find_resend_targets(target):
    """Resolves the resend command's target selector against the latest
    successful (status == "ok") row per clip:
      - "all"    -> every successful clip ever processed
      - "recent" -> successful clips from the last 24 hours
      - anything else -> treated as a filename (matched against either
        the name stored at process time, or that name with DONE_
        prefixed — since Drive renames the file after success, but the
        CSV keeps whatever name was current when it was logged)
    """
    successful = [row for row in latest_status_per_clip().values() if row.get("status") == "ok"]

    if target == "all":
        return successful

    if target == "recent":
        cutoff = datetime.now(timezone.utc) - timedelta(days=1)
        out = []
        for row in successful:
            try:
                ts = datetime.fromisoformat(row["timestamp"])
            except (KeyError, ValueError):
                continue
            if ts >= cutoff:
                out.append(row)
        return out

    target_lower = target.lower()
    return [
        row
        for row in successful
        if row.get("filename", "").lower() in (target_lower, f"done_{target_lower}")
    ]
