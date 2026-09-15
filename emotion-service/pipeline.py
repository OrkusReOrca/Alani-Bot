"""Orchestrates one whole run (run1/runany/runall): lists the relevant
clips from Drive, processes each one end-to-end, and reports back to
Alani-Bot's own bridge routes as it goes — see the root plan's sequence
diagram. Runs on a background thread (started by main.py) so the
triggering POST /run can return immediately.
"""

import base64
import os
import shutil
import tempfile
import traceback

import requests

import config
import drive
import video
import store
import prompt
import detector
from extract_au import extract_au_values, format_au_string
from extract_voice import extract_voice_features, format_voice_string
from extract_transcript import extract_transcript
from extract_pose import extract_pose_features, format_eye_string, format_head_string
from openrouter_client import classify

ALL_MODALITIES = ["AU", "T", "VO", "ET", "HT"]


def _post(path, payload):
    if not config.ALANI_BOT_URL or not config.SHARED_SECRET:
        print(f"[pipeline] ALANI_BOT_URL/EMOTION_SERVICE_SECRET not set — skipping callback to {path}")
        return
    try:
        requests.post(
            f"{config.ALANI_BOT_URL.rstrip('/')}{path}",
            headers={"Authorization": f"Bearer {config.SHARED_SECRET}", "Content-Type": "application/json"},
            json=payload,
            timeout=30,
        )
    except Exception as e:
        print(f"[pipeline] callback to {path} failed: {e}")


def _post_result(clip_name, success, prediction=None, error=None, first_frame_path=None):
    payload = {"clipName": clip_name, "success": success}
    if success:
        payload["prediction"] = prediction
        if first_frame_path and os.path.exists(first_frame_path):
            with open(first_frame_path, "rb") as f:
                payload["firstFrameBase64"] = base64.b64encode(f.read()).decode("ascii")
    else:
        payload["error"] = error
    _post("/emotion/result", payload)


def _process_clip(file_obj, modalities, cache_mode, invoked_by, run_mode):
    file_id, filename = file_obj["id"], file_obj["name"]
    work_dir = tempfile.mkdtemp(prefix="emotion_")
    try:
        src_path = os.path.join(work_dir, filename)
        drive.download_file(file_id, src_path)
        working_path, _truncated = video.truncate_if_needed(src_path, work_dir)

        cache = store.load_clip_cache(file_id)
        # "d" caches every modality regardless of what's requested this run
        # (so a future run with a different m-list is instant); "s" only
        # extracts what's actually in the requested list.
        extract_set = ALL_MODALITIES if cache_mode == "d" else modalities

        frame_paths = video.extract_frames(working_path, work_dir)
        first_frame_path = frame_paths[0] if frame_paths else None

        # One shared py-feat pass covers both AU and eye/head-pose (see
        # detector.py) — only actually run if at least one of them is
        # still needed, so a run that only wants T/VO never pays for it.
        needs_au = "AU" in extract_set and "au_string" not in cache
        needs_pose = ("ET" in extract_set or "HT" in extract_set) and (
            "eye_string" not in cache or "head_string" not in cache
        )
        if needs_au or needs_pose:
            detection = detector.detect_frames(frame_paths)
            if needs_au:
                cache["au_string"] = format_au_string(extract_au_values(detection))
            if needs_pose:
                pose_feat = extract_pose_features(detection)
                cache.setdefault("eye_string", format_eye_string(pose_feat))
                cache.setdefault("head_string", format_head_string(pose_feat))

        needs_audio = ("T" in extract_set and "transcript" not in cache) or (
            "VO" in extract_set and "voice_string" not in cache
        )
        audio_path = video.extract_audio(working_path, work_dir) if needs_audio else None

        if "T" in extract_set and "transcript" not in cache:
            cache["transcript"] = extract_transcript(audio_path)
        if "VO" in extract_set and "voice_string" not in cache:
            cache["voice_string"] = format_voice_string(extract_voice_features(audio_path))

        store.save_clip_cache(file_id, cache)

        au_string = cache.get("au_string", "")
        transcript = cache.get("transcript", "")
        voice_string = cache.get("voice_string", "")
        eye_string = cache.get("eye_string", "")
        head_string = cache.get("head_string", "")

        valence_prompt = prompt.build_prompt_valence(modalities, au_string, transcript, voice_string, eye_string, head_string)
        valence_raw = classify(frame_paths, valence_prompt, max_tokens=8)
        valence = prompt.parse_valence(valence_raw)

        arousal_prompt = prompt.build_prompt_arousal(
            valence, modalities, au_string, transcript, voice_string, eye_string, head_string
        )
        arousal_raw = classify(frame_paths, arousal_prompt, max_tokens=8)
        arousal = prompt.parse_arousal(arousal_raw)

        result_label = prompt.combine(valence, arousal)
        short = prompt.SHORT_CODE.get(result_label, result_label)

        cache["last_valence_raw"] = valence_raw
        cache["last_arousal_raw"] = arousal_raw
        cache["last_prediction"] = result_label
        cache["last_modalities"] = modalities
        store.save_clip_cache(file_id, cache)

        store.append_log_row(
            file_id=file_id, filename=filename, invoked_by=invoked_by, run_mode=run_mode,
            modalities=modalities, cache_mode=cache_mode, status="ok",
            prediction=result_label, valence_raw=valence_raw, arousal_raw=arousal_raw,
        )

        drive.mark_done(file_id, filename)
        _post_result(filename, True, prediction=f"{result_label} ({short})", first_frame_path=first_frame_path)
        return True
    except Exception as e:
        traceback.print_exc()
        store.append_log_row(
            file_id=file_id, filename=filename, invoked_by=invoked_by, run_mode=run_mode,
            modalities=modalities, cache_mode=cache_mode, status="error", error=str(e),
        )
        # Deliberately NOT renamed on failure — left as-is so the next
        # run1/runany retries it automatically, per the confirmed behavior.
        _post_result(filename, False, error=str(e))
        return False
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


def run(run_mode, modalities, cache_mode, invoked_by):
    folder_id = drive.resolve_input_folder_id()

    if run_mode == "run1":
        clips = drive.list_pending_clips(folder_id)[:1]
    elif run_mode == "runany":
        clips = drive.list_pending_clips(folder_id)
    else:  # runall
        clips = drive.list_all_clips(folder_id)

    succeeded = failed = 0
    for clip in clips:
        if _process_clip(clip, modalities, cache_mode, invoked_by, run_mode):
            succeeded += 1
        else:
            failed += 1

    _post("/emotion/batch-done", {"total": len(clips), "succeeded": succeeded, "failed": failed})
