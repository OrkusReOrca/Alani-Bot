"""Dev/test stand-in for core.process() — selected by EMOTION_FAKE_PIPELINE=1.

The cloud/dev machine has no torch, py-feat, whisper or ffmpeg, yet the web
layer (login, upload, queue, progress, reruns, retention, the whole UI) has to
be developed and verified end to end. This module has the exact same signature,
stage order, caching/checkpoint behaviour and result shape as core.process()
(it shares stages.Plan with it), sleeps a moment per stage and returns a canned
result with generated placeholder images. It needs nothing beyond the standard
library.

Test hook: `FAIL_MODEL_CALLS` makes that many model calls fail as a busy provider
would, so the failure / auto-retry paths can be exercised.
"""

import os
import struct
import time
import zlib

import config
import store
from stages import Plan

DELAY_S = float(os.environ.get("EMOTION_FAKE_DELAY", "0.6"))
FAIL_MODEL_CALLS = int(os.environ.get("EMOTION_FAKE_FAIL_MODEL", "0"))  # how many upcoming model calls report "rate-limited"
RETRY_WAIT_S = 0.05  # the real client waits 4 s and up; the stand-in does not

_FAKE_AU = {"AU06": 3.9, "AU12": 4.2, "AU25": 2.1, "AU01": 1.4, "AU02": 0.9, "AU04": 0.2, "AU07": 1.1, "AU10": 0.6,
            "AU14": 0.5, "AU15": 0.1, "AU17": 0.7, "AU20": 0.3, "AU23": 0.2, "AU26": 0.8, "AU45": 0.4}
_FAKE_POSE = {"head_pitch_mean": 0.04, "head_pitch_std": 0.05, "head_yaw_mean": -0.12, "head_yaw_std": 0.08,
              "head_roll_mean": 0.03, "head_roll_std": 0.04, "head_movement_range": 0.2,
              "gaze_x_mean": 0.05, "gaze_x_std": 0.06, "gaze_y_mean": -0.02, "gaze_y_std": 0.05}
_TRANSCRIPT = "Hello everyone, I am really excited to show you the demo today. I hope you like it."
_VOICE = "Voice acoustics (eGeMAPS):\n  Pitch: 182 Hz, variation=14.2%\n  Loudness: 0.842 sone\n  Rate: 3.10 seg/sec\n  Quality: jitter=1.20%, HNR=14.3 dB"


class BusyProvider(RuntimeError):
    pass


def _png(path, width, height, rgb):
    """Smallest possible valid PNG: a flat colour with a slightly lighter band."""
    rows = bytearray()
    for y in range(height):
        rows.append(0)
        shade = 18 if (y // 24) % 2 else 0
        rows += bytes(min(255, c + shade) for c in rgb) * width

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
    data += chunk(b"IDAT", zlib.compress(bytes(rows))) + chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(data)


def process(clip_id, src_path, modalities, cache_mode, more_info, progress, work_dir, persist_dir=None, render_annotated=False, auto_retry=False):
    global FAIL_MODEL_CALLS
    started = time.monotonic()
    want_annotated = more_info or render_annotated
    cache = store.load_clip_cache(clip_id)
    keep_dir = persist_dir or work_dir
    frames_dir = os.path.join(keep_dir, "frames")
    os.makedirs(frames_dir, exist_ok=True)
    annotated_path = os.path.join(keep_dir, "annotated.png")
    plan = Plan(cache, modalities, cache_mode, want_annotated, sorted(os.listdir(frames_dir)), os.path.exists(annotated_path))
    meter = plan.meter(progress)

    def step(stage, detail):
        meter.begin(stage, detail)
        time.sleep(DELAY_S)

    def finish(stage):
        meter.end(stage)
        cache.setdefault("stage_seconds", {})[stage] = meter.timings[stage]
        store.save_clip_cache(clip_id, cache)

    if plan.need_working_video:
        step("truncating", "Checking the video and trimming it to the first %d seconds if it is longer" % config.MAX_CLIP_SECONDS)
        if not os.path.exists(src_path) or os.path.getsize(src_path) == 0:
            raise RuntimeError("The video file is empty or unreadable")
        cache.setdefault("clip_meta", {}).update({"seconds": 42.0, "full_seconds": 42.0, "truncated": False})
        finish("truncating")
    if plan.need_frames:
        step("frames", "Sampling up to %d frames evenly across the clip" % config.MAX_VLM_FRAMES)
        for i in range(8):
            _png(os.path.join(frames_dir, "frame_%03d.jpg" % i), 160, 120, (150 + i * 8, 120, 100))
        cache["clip_meta"]["frame_count"] = 8
        finish("frames")
    if plan.need_detection:
        step("face", "Reading the face in 8 frames with py-feat: facial action units, eye gaze and head pose (simulated)")
        if plan.needs_au:
            cache["au_values"] = dict(_FAKE_AU)
            cache["au_string"] = "; ".join("%s: %.2f (%s)" % (k, v, "present" if v >= 1 else "absent") for k, v in sorted(_FAKE_AU.items()))
        if plan.needs_pose:
            cache["pose_features"] = dict(_FAKE_POSE)
            cache.setdefault("eye_string", "Eye gaze: steady and centered (simulated)")
            cache.setdefault("head_string", "Head pose: near neutral (simulated)")
        finish("face")
    annotated = annotated_path if os.path.exists(annotated_path) else None
    if plan.needs_annotation:
        step("finalizing", "Drawing the annotated frame (simulated)")
        _png(annotated_path, 640, 480, (236, 224, 214))
        annotated = annotated_path
        finish("finalizing")

    if plan.needs_audio:
        step("audio", "Extracting the audio track")
        finish("audio")
    if plan.need_transcript:
        step("transcript", "Transcribing the speech with Whisper (simulated)")
        cache["transcript"] = _TRANSCRIPT
        finish("transcript")
    if plan.need_voice:
        step("voice", "Measuring voice pitch, loudness and speaking rate with openSMILE (simulated)")
        cache["voice_string"] = _VOICE
        finish("voice")
    store.save_clip_cache(clip_id, cache)
    preprocess_done_at = time.time()

    def ask(stage, detail):
        """A model question that fails like a busy provider while FAIL_MODEL_CALLS lasts."""
        global FAIL_MODEL_CALLS
        meter.begin(stage, detail)
        attempt = 0
        while True:
            time.sleep(DELAY_S)
            if FAIL_MODEL_CALLS <= 0:
                break
            FAIL_MODEL_CALLS -= 1
            if not auto_retry:
                raise BusyProvider("The model provider is busy: the request was rate-limited by Parasail (OpenRouter 429).")
            attempt += 1
            meter.note(stage, "The model provider is busy. Trying again in 0 s (retry %d)." % attempt)
            time.sleep(RETRY_WAIT_S)
        meter.end(stage)

    ask("vlm_valence", "Asking Qwen3-VL whether the person's emotional tone is positive or negative (simulated)")
    ask("vlm_arousal", "Asking Qwen3-VL whether the person's energy level is active or deactivated (simulated)")
    vlm_done_at = time.time()

    # Fewer modalities -> a different answer, so reruns visibly differ in the comparison table.
    valence, arousal = ("positive", "active") if "AU" in modalities else ("negative", "deactivate")
    label = {("positive", "active"): "Positive_Activate", ("negative", "deactivate"): "Negative_Deactivate"}[(valence, arousal)]
    short = "PA" if label == "Positive_Activate" else "ND"
    valence_prompt = "FAKE valence prompt for modalities " + ".".join(modalities)
    arousal_prompt = "FAKE arousal prompt for modalities " + ".".join(modalities)
    cache.update(last_prediction=label, last_modalities=list(modalities))
    store.save_clip_cache(clip_id, cache)

    thumb = os.path.join(keep_dir, "first_frame.jpg" if persist_dir else "thumb.jpg")
    if not os.path.exists(thumb):
        _png(thumb, 320, 240, (150, 120, 100))

    meta = cache.get("clip_meta", {})
    return {
        "prediction": label, "short": short, "valence": valence, "arousal": arousal,
        "valence_raw": valence, "arousal_raw": arousal,
        "valence_prompt": valence_prompt, "arousal_prompt": arousal_prompt,
        "au_string": cache.get("au_string", ""), "transcript": cache.get("transcript", ""),
        "voice_string": cache.get("voice_string", ""), "eye_string": cache.get("eye_string", ""),
        "head_string": cache.get("head_string", ""),
        "au_values": cache.get("au_values", {}), "pose_features": cache.get("pose_features", {}),
        "modalities_used": list(modalities),
        "stage_timings": meter.timings,
        "stage_cached_seconds": {s: meter.cached[s] for s, st in meter.status.items() if st == "cached" and s in meter.cached},
        "stage_status": meter.status,
        "total_seconds": round(time.monotonic() - started, 2),
        "frame_count": 8, "frames": ["frame_%03d.jpg" % i for i in range(8)],
        "clip_seconds": meta.get("seconds"), "full_seconds": meta.get("full_seconds"), "truncated": bool(meta.get("truncated")),
        "files": {"first_frame": thumb, "annotated": annotated},
        "marks": {"preprocess_done": preprocess_done_at, "vlm_done": vlm_done_at},
    }


def warm_up():
    """Stands in for loading the heavy models."""
    time.sleep(DELAY_S * 2)
