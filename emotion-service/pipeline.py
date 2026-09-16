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
import tempfile
import traceback

import drive
import video
import store
import prompt
import detector
import callback
import visualize
from extract_au import extract_au_values, format_au_string
from extract_voice import extract_voice_features, format_voice_string
from extract_transcript import extract_transcript
from extract_pose import extract_pose_features, format_eye_string, format_head_string
from openrouter_client import classify

ALL_MODALITIES = ["AU", "T", "VO", "ET", "HT"]


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


def _process_clip(file_obj, modalities, cache_mode, invoked_by, run_mode, more_info):
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
        # The VLM's own frames stay full-resolution (frame_paths, below) —
        # only the copy that gets persisted/sent to Discord is shrunk. See
        # video.make_thumbnail()'s own docstring for why this matters.
        first_frame_thumb = None
        if frame_paths:
            first_frame_thumb = video.make_thumbnail(frame_paths[0], os.path.join(work_dir, "thumb.jpg"))

        # One shared py-feat pass covers both AU and eye/head-pose (see
        # detector.py) — only actually run if at least one of them is
        # still needed, so a run that only wants T/VO never pays for it.
        # "more_info" forces it regardless — the annotated image below
        # needs a detection result to draw on even if this run's own
        # modality list never asked for AU/ET/HT.
        needs_au = "AU" in extract_set and "au_string" not in cache
        needs_pose = ("ET" in extract_set or "HT" in extract_set) and (
            "eye_string" not in cache or "head_string" not in cache
        )
        detection = None
        if needs_au or needs_pose or more_info:
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
        if more_info:
            # Cached so ".a emo resend" can still show the full prompt
            # block later without needing to reconstruct it (modalities
            # can change between runs, so these have to be the exact
            # strings actually sent, not rebuilt from current cache state).
            cache["last_valence_prompt"] = valence_prompt
            cache["last_arousal_prompt"] = arousal_prompt
        store.save_clip_cache(file_id, cache)

        store.append_log_row(
            file_id=file_id, filename=filename, invoked_by=invoked_by, run_mode=run_mode,
            modalities=modalities, cache_mode=cache_mode, status="ok",
            prediction=result_label, valence_raw=valence_raw, arousal_raw=arousal_raw,
        )

        # Plain thumbnail by default; the annotated version (py-feat's own
        # plot_detections — box, landmarks, AU bars, pose) replaces it in
        # more_info mode. A plot failure falls back to the plain thumbnail
        # rather than losing the result over a drawing bug.
        image_to_send = first_frame_thumb
        if more_info and detection is not None and len(detection) > 0:
            annotated_path = os.path.join(work_dir, "annotated.png")
            annotated = visualize.render_annotated_frame(detection.iloc[[0]], annotated_path)
            if annotated:
                image_to_send = annotated

        # Persisted out of work_dir before it gets deleted below — this is
        # what makes ".a emo resend" possible later without recomputing
        # anything (see store.py's own docstring on this).
        store.save_first_frame(file_id, image_to_send)

        drive.mark_done(file_id, filename)
        callback.post_result(
            filename, True, prediction=f"{result_label} ({short})", first_frame_path=image_to_send,
            valence_prompt=valence_prompt if more_info else None,
            arousal_prompt=arousal_prompt if more_info else None,
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


def run_clips(clips, modalities, cache_mode, invoked_by, run_mode, more_info):
    succeeded = failed = 0
    for clip in clips:
        if _process_clip(clip, modalities, cache_mode, invoked_by, run_mode, more_info):
            succeeded += 1
        else:
            failed += 1

    callback.post("/emotion/batch-done", {"total": len(clips), "succeeded": succeeded, "failed": failed})
