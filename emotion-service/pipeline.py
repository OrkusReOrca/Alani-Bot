"""Orchestrates one whole run (run1/runany/runall): lists the relevant
clips from Drive, processes each one end-to-end, and reports back to
Alani-Bot's own bridge routes as it goes — see the root plan's sequence
diagram.

Split into resolve_clips() (fast — just a Drive listing, called
synchronously by main.py so the ack reply can name the actual clips
about to run) and run_clips() (the actual work, which runs on a
background thread so the triggering POST /run can still return
immediately once the list above is known).
"""

import os
import shutil
import time
import tempfile
import traceback
from datetime import datetime

import callback
import core
import drive
import runtime
import store

def _parse_drive_time_ms(rfc3339):
    """Drive's createdTime ("2026-09-19T05:12:33.123Z") -> epoch ms, or
    None if absent/unparseable."""
    if not rfc3339:
        return None
    try:
        return int(datetime.fromisoformat(rfc3339.replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        return None



def resolve_clips(run_mode):
    """Fast — just lists Drive, no downloading/processing. Called
    synchronously so the Discord ack can name the actual clips before
    the (much slower) real work starts."""
    folder_id = drive.resolve_input_folder_id()
    if run_mode == "run1":
        return drive.list_pending_clips(folder_id)[:1]
    if run_mode == "runany":
        return drive.list_pending_clips(folder_id)
    return drive.list_all_clips(folder_id)  # runall


def _process_clip(file_obj, modalities, cache_mode, invoked_by, run_mode, more_info, command_at_ms, run_received_at):
    """The Drive flow for one clip: download it, run core.process() (the
    source-agnostic analysis, shared with the web dashboard), then log it,
    rename it DONE_ and call Alani-Bot back. This is the backup path that is
    switched off while the web dashboard is on (see main.py)."""
    file_id, filename = file_obj["id"], file_obj["name"]
    work_dir = tempfile.mkdtemp(prefix="emotion_")
    try:
        src_path = os.path.join(work_dir, filename)
        drive.download_file(file_id, src_path)

        # One heavy analysis at a time across Discord AND web runs (runtime.py).
        with runtime.heavy_lock:
            result = core.process(file_id, src_path, modalities, cache_mode, more_info, None, work_dir)

        # T+0 is the moment the Discord command was given (commandAtMs,
        # Alani-Bot's clock); the two offsets below are measured on THIS
        # service's own clock from when /run was received, so the two
        # containers' clocks never get subtracted from each other.
        timeline = {
            "uploadedAtMs": _parse_drive_time_ms(file_obj.get("createdTime")),
            "commandAtMs": command_at_ms,
            "preprocessDoneS": round(result["marks"]["preprocess_done"] - run_received_at, 1),
            "vlmDoneS": round(result["marks"]["vlm_done"] - run_received_at, 1),
        }
        result_label = result["prediction"]
        short = result["short"]
        if more_info:
            # Cached so ".a emo resend" can still show the full prompt block
            # later (core already cached the prompts themselves).
            cache = store.load_clip_cache(file_id)
            cache["last_timeline"] = timeline
            store.save_clip_cache(file_id, cache)

        store.append_log_row(
            file_id=file_id, filename=filename, invoked_by=invoked_by, run_mode=run_mode,
            modalities=modalities, cache_mode=cache_mode, status="ok",
            prediction=result_label, valence_raw=result["valence_raw"], arousal_raw=result["arousal_raw"],
        )

        # Plain thumbnail by default; the annotated version (py-feat's own
        # plot_detections — box, landmarks, AU bars, pose) replaces it in
        # more_info mode. A plot failure falls back to the plain thumbnail
        # rather than losing the result over a drawing bug.
        image_to_send = result["files"]["annotated"] or result["files"]["first_frame"]

        # Persisted out of work_dir before it gets deleted below — this is
        # what makes ".a emo resend" possible later without recomputing
        # anything (see store.py's own docstring on this).
        store.save_first_frame(file_id, image_to_send)

        drive.mark_done(file_id, filename)
        callback.post_result(
            filename, True, prediction=f"{result_label} ({short})", first_frame_path=image_to_send,
            valence_prompt=result["valence_prompt"] if more_info else None,
            arousal_prompt=result["arousal_prompt"] if more_info else None,
            timeline=timeline if more_info else None,
        )
        return True
    except Exception as e:
        traceback.print_exc()
        store.append_log_row(
            file_id=file_id, filename=filename, invoked_by=invoked_by, run_mode=run_mode,
            modalities=modalities, cache_mode=cache_mode, status="error", error=str(e),
        )
        # Deliberately NOT renamed on failure — left as-is so the next
        # run1/runany retries it automatically, per the confirmed behavior.
        callback.post_result(filename, False, error=str(e))
        return False
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


def run_clips(clips, modalities, cache_mode, invoked_by, run_mode, more_info, command_at_ms=None, run_received_at=None):
    run_received_at = run_received_at or time.time()
    succeeded = failed = 0
    for clip in clips:
        if _process_clip(clip, modalities, cache_mode, invoked_by, run_mode, more_info, command_at_ms, run_received_at):
            succeeded += 1
        else:
            failed += 1

    callback.post("/emotion/batch-done", {"total": len(clips), "succeeded": succeeded, "failed": failed})
