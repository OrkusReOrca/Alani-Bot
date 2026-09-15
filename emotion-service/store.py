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
from datetime import datetime, timezone

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
