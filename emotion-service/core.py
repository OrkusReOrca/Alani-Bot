"""The source-agnostic heart of one analysis: video file in, prediction out.

This is everything that used to live inside pipeline._process_clip between
"the video is on disk" and "the prediction is cached" — truncate to the
2-minute cap, sample frames, one shared py-feat pass (AU + gaze + head pose),
audio -> transcript + voice features, build the two ValAro prompts, ask the
VLM twice, combine into a circumplex quadrant.

It knows nothing about Google Drive, Discord callbacks or renaming files:
  - the Drive flow (pipeline.py) downloads a clip, calls process(), then does
    its own logging / DONE_ rename / Discord callback;
  - the web dashboard (web_jobs.py) calls process() with a persistent
    `persist_dir`, so the sampled frames, the annotated frame and every cached
    modality survive between runs and a re-analysis with other modalities only
    redoes what is missing.

Everything is reported through `progress(stage, detail, percent=...)` so the UI
can show what is happening right now. Stage ids are a fixed vocabulary (the
frontend maps them to labels): queued, truncating, frames, face, audio,
finalizing, audio, transcript, voice, vlm_valence, vlm_arousal, done, error.
"""

import glob
import os
import time

import config
import detector
import prompt
import store
import video
import visualize
from stages import Plan
from extract_au import extract_au_values, format_au_string
from extract_pose import extract_pose_features, format_eye_string, format_head_string
from extract_transcript import extract_transcript
from extract_voice import extract_voice_features, format_voice_string
from openrouter_client import classify


def _existing_frames(frames_dir):
    return sorted(glob.glob(os.path.join(frames_dir, "frame_*.jpg")))


def process(clip_id, src_path, modalities, cache_mode, more_info, progress, work_dir, persist_dir=None, render_annotated=False, auto_retry=False):
    """Analyse one video. Returns the result dict (see bottom).

    clip_id      key of the per-clip cache JSON in store.py (a Drive fileId, or "web_<id>")
    modalities   what goes into the prompt this run (subset of ALL_MODALITIES)
    cache_mode   "d" extract+cache all five regardless, "s" only the requested
    more_info    Discord "mif": also produce py-feat's annotated frame
    render_annotated  same, for the web dashboard (which always shows it)
    work_dir     scratch space, deleted by the caller afterwards
    persist_dir  if given, frames / thumbnail / annotated frame live here and are
                 reused on the next call instead of being recomputed
    auto_retry   keep asking the model again while its provider is busy (rate-limited), up to
                 config.AUTO_RETRY_MAX_S; off = one attempt, as in the Discord flow
    """
    started = time.monotonic()
    want_annotated = more_info or render_annotated

    cache = store.load_clip_cache(clip_id)
    frames_dir = os.path.join(persist_dir, "frames") if persist_dir else work_dir
    keep_dir = persist_dir or work_dir
    annotated_path = os.path.join(keep_dir, "annotated.png")
    thumb_path = os.path.join(keep_dir, "first_frame.jpg" if persist_dir else "thumb.jpg")
    os.makedirs(frames_dir, exist_ok=True)

    have_frames = _existing_frames(frames_dir) if persist_dir else []
    have_annotated = persist_dir is not None and os.path.exists(annotated_path)
    plan = Plan(cache, modalities, cache_mode, want_annotated, have_frames, have_annotated)
    meter = plan.meter(progress)
    needs_au, needs_pose = plan.needs_au, plan.needs_pose
    need_frames, need_detection = plan.need_frames, plan.need_detection
    need_transcript, need_voice, needs_audio = plan.need_transcript, plan.need_voice, plan.needs_audio

    def finish(stage):
        """End a stage and save everything learned so far, with how long it took. Saving after every
        stage (not once at the end) means a crash or a model failure later never throws away the work
        and the timings of the stages that did finish — a re-run reuses and reports them."""
        meter.end(stage)
        cache.setdefault("stage_seconds", {})[stage] = meter.timings[stage]
        store.save_clip_cache(clip_id, cache)

    # ---- the clip itself: cap its length, then sample frames ----
    working_path = None
    if plan.need_working_video:
        meter.begin("truncating", "Checking the video and trimming it to the first %d seconds if it is longer" % config.MAX_CLIP_SECONDS)
        duration, _ = video.get_duration_and_frame_count(src_path)
        working_path, truncated = video.truncate_if_needed(src_path, work_dir)
        cache.setdefault("clip_meta", {}).update(
            {"seconds": round(min(duration, config.MAX_CLIP_SECONDS), 1), "full_seconds": round(duration, 1), "truncated": bool(truncated)}
        )
        finish("truncating")

    if need_frames:
        meter.begin("frames", "Sampling up to %d frames evenly across the clip" % config.MAX_VLM_FRAMES)
        frame_paths = video.extract_frames(working_path, frames_dir)
        cache["clip_meta"]["frame_count"] = len(frame_paths)
        finish("frames")
    else:
        frame_paths = have_frames

    # The VLM's own frames stay full-resolution — only this copy (shown in the
    # UI / sent to Discord) is shrunk. See video.make_thumbnail().
    first_frame_thumb = thumb_path if os.path.exists(thumb_path) else None
    if first_frame_thumb is None and frame_paths:
        first_frame_thumb = video.make_thumbnail(frame_paths[0], thumb_path)

    # ---- face: AU + gaze + head pose in one py-feat pass ----
    detection = None
    if need_detection:
        meter.begin("face", "Reading the face in %d frames with py-feat: facial action units, eye gaze and head pose. The first run also loads the model, which can take minutes" % len(frame_paths))
        detection = detector.detect_frames(frame_paths)
        if needs_au:
            au_values = extract_au_values(detection)
            cache["au_values"] = au_values
            cache["au_string"] = format_au_string(au_values)
        if needs_pose:
            pose_feat = extract_pose_features(detection)
            cache["pose_features"] = pose_feat
            cache.setdefault("eye_string", format_eye_string(pose_feat))
            cache.setdefault("head_string", format_head_string(pose_feat))
        finish("face")

    # ---- the annotated frame (py-feat's own drawing) ----
    # Drawn right after the face pass (needs its detection), not at the end: a later failure (the model's
    # rate limit, a crashed transcript...) must not leave the picture undrawn, or every retry would have to
    # redo the whole face pass just to draw it.
    annotated = annotated_path if have_annotated else None
    if plan.needs_annotation:
        meter.begin("finalizing", "Drawing the annotated frame: face box, landmarks, action-unit bars, head pose and gaze")
        if detection is not None and len(detection) > 0:
            annotated = visualize.render_annotated_frame(detection.iloc[[0]], annotated_path)
        if annotated is None:
            cache["annotated_failed"] = True  # do not re-run the face pass again just to retry the drawing
        finish("finalizing")

    # ---- sound: transcript and voice features ----
    audio_path = None
    if needs_audio:
        meter.begin("audio", "Extracting the audio track")
        audio_path = video.extract_audio(working_path, work_dir)
        finish("audio")
    if need_transcript:
        meter.begin("transcript", "Transcribing the speech with Whisper (%s). Silent clips finish instantly" % config.WHISPER_MODEL)
        cache["transcript"] = extract_transcript(audio_path)
        finish("transcript")
    if need_voice:
        meter.begin("voice", "Measuring voice pitch, loudness and speaking rate with openSMILE")
        cache["voice_string"] = format_voice_string(extract_voice_features(audio_path))
        finish("voice")

    store.save_clip_cache(clip_id, cache)
    drawing_seconds = meter.timings.get("finalizing", 0)
    preprocess_done_at = time.time() - drawing_seconds  # the drawing is not part of "preprocess" in the Discord timeline

    au_string = cache.get("au_string", "")
    transcript = cache.get("transcript", "")
    voice_string = cache.get("voice_string", "")
    eye_string = cache.get("eye_string", "")
    head_string = cache.get("head_string", "")

    # ---- the two VLM questions ----
    def ask(stage, prompt_text):
        """One model question. With auto_retry a busy provider is waited out (and the page says so)."""
        deadline = time.time() + config.AUTO_RETRY_MAX_S if auto_retry else None

        def waiting(attempt, seconds, reason):
            meter.note(stage, "%s Trying again in %d s (retry %d, up to %d min in total)." % (reason, seconds, attempt, config.AUTO_RETRY_MAX_S // 60))

        return classify(frame_paths, prompt_text, max_tokens=8, retry_until=deadline, on_wait=waiting)

    valence_prompt = prompt.build_prompt_valence(modalities, au_string, transcript, voice_string, eye_string, head_string)
    meter.begin("vlm_valence", "Asking Qwen3-VL whether the person's emotional tone is positive or negative (%d frames + the prompt)" % len(frame_paths))
    valence_raw = ask("vlm_valence", valence_prompt)
    valence = prompt.parse_valence(valence_raw)
    meter.end("vlm_valence")

    arousal_prompt = prompt.build_prompt_arousal(valence, modalities, au_string, transcript, voice_string, eye_string, head_string)
    meter.begin("vlm_arousal", "Asking Qwen3-VL whether the person's energy level is active or deactivated, knowing the tone is %s" % valence)
    arousal_raw = ask("vlm_arousal", arousal_prompt)
    arousal = prompt.parse_arousal(arousal_raw)
    meter.end("vlm_arousal")
    vlm_done_at = time.time() - drawing_seconds  # the drawing is not part of "model time" in the Discord timeline

    label = prompt.combine(valence, arousal)
    short = prompt.SHORT_CODE.get(label, label)

    cache["last_valence_raw"] = valence_raw
    cache["last_arousal_raw"] = arousal_raw
    cache["last_prediction"] = label
    cache["last_modalities"] = modalities
    if want_annotated:
        # The exact strings sent (modalities can change between runs, so they
        # can't be rebuilt from the current cache). Discord's resend reads these.
        cache["last_valence_prompt"] = valence_prompt
        cache["last_arousal_prompt"] = arousal_prompt
    store.save_clip_cache(clip_id, cache)

    meta = cache.get("clip_meta", {})
    return {
        "prediction": label,
        "short": short,
        "valence": valence,
        "arousal": arousal,
        "valence_raw": valence_raw,
        "arousal_raw": arousal_raw,
        "valence_prompt": valence_prompt,
        "arousal_prompt": arousal_prompt,
        "au_string": au_string,
        "transcript": transcript,
        "voice_string": voice_string,
        "eye_string": eye_string,
        "head_string": head_string,
        "au_values": cache.get("au_values", {}),
        "pose_features": cache.get("pose_features", {}),
        "modalities_used": list(modalities),
        "stage_timings": meter.timings,
        "stage_cached_seconds": {stage: meter.cached[stage] for stage, status in meter.status.items() if status == "cached" and stage in meter.cached},
        "stage_status": meter.status,
        "total_seconds": round(time.monotonic() - started, 2),
        "frame_count": len(frame_paths),
        "frames": [os.path.basename(p) for p in frame_paths],
        "clip_seconds": meta.get("seconds"),
        "full_seconds": meta.get("full_seconds"),
        "truncated": bool(meta.get("truncated")),
        "files": {"first_frame": first_frame_thumb, "annotated": annotated},
        "marks": {"preprocess_done": preprocess_done_at, "vlm_done": vlm_done_at},
    }
