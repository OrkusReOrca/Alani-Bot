"""Video handling: truncate to the 2-minute cap, extract the uniformly-
sampled frames the VLM prompt needs, and pull out an audio track for
transcript/voice-acoustics extraction.

Uses `imageio_ffmpeg` (pip-installable, bundles its own portable ffmpeg
binary) rather than assuming a system ffmpeg install — bot-hosting.net's
actual Python environment for this is untested, and this removes one
more "does this even run here" unknown (see the plan's own note on this).

MOV needs no separate "conversion" step — ffmpeg reads MOV containers
natively for both frame and audio extraction, so there's no dedicated
converter component here despite the user's initial ask for one; it
would be extracting from an already-correctly-read container either way.
"""

import os
import subprocess

import cv2
import imageio_ffmpeg

import config


def _ffmpeg_path():
    return imageio_ffmpeg.get_ffmpeg_exe()


def get_duration_and_frame_count(path):
    cap = cv2.VideoCapture(path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    cap.release()
    duration = (total_frames / fps) if fps else 0
    return duration, total_frames


def truncate_if_needed(src_path, work_dir):
    """Returns the path to work with from here on — either src_path
    unchanged, or a truncated copy capped at config.MAX_CLIP_SECONDS.
    Stream-copies (no re-encode) since we only need a duration cut, not a
    format change."""
    duration, _ = get_duration_and_frame_count(src_path)
    if duration <= config.MAX_CLIP_SECONDS:
        return src_path, False

    trimmed_path = os.path.join(work_dir, "trimmed.mp4")
    subprocess.run(
        [_ffmpeg_path(), "-y", "-i", src_path, "-t", str(config.MAX_CLIP_SECONDS), "-c", "copy", trimmed_path],
        check=True,
        capture_output=True,
    )
    return trimmed_path, True


def safe_frame_count(total_frames):
    """Same formula as the source pipeline's run_phase2j_qwen3_..._ValAro.py:
    safe_n = max(2, min(32, total_frames-1))."""
    if total_frames <= 1:
        return 2
    return max(2, min(config.MAX_VLM_FRAMES, total_frames - 1))


def extract_frames(path, work_dir):
    """Uniformly samples safe_frame_count(total_frames) frames and writes
    them as JPEGs. Returns the list of file paths, in order."""
    _, total_frames = get_duration_and_frame_count(path)
    n = safe_frame_count(total_frames)
    cap = cv2.VideoCapture(path)
    indices = [int(i * total_frames / n) for i in range(n)] if total_frames > 0 else [0]

    frame_paths = []
    for idx, frame_idx in enumerate(indices):
        cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
        ok, frame = cap.read()
        if not ok:
            continue
        frame_path = os.path.join(work_dir, f"frame_{idx:03d}.jpg")
        cv2.imwrite(frame_path, frame)
        frame_paths.append(frame_path)
    cap.release()
    return frame_paths


def make_thumbnail(src_path, dest_path, max_dim=1024, quality=80):
    """Downscaled, recompressed copy of one frame — specifically for the
    Discord attachment / persisted-for-resend copy, NOT the frames sent to
    OpenRouter (those stay at full extracted resolution; shrinking those
    would risk losing exactly the facial detail the VLM needs). A phone/
    iPad-recorded frame at full resolution, base64-encoded into a JSON
    callback body, was very likely enough to OOM-crash the Node bot's
    deliberately small (1GB) container in practice — this exists so that
    never has a reason to happen again, independent of whatever the exact
    root cause turns out to be."""
    img = cv2.imread(src_path)
    if img is None:
        return None
    h, w = img.shape[:2]
    scale = min(1.0, max_dim / max(h, w))
    if scale < 1.0:
        img = cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
    cv2.imwrite(dest_path, img, [cv2.IMWRITE_JPEG_QUALITY, quality])
    return dest_path


def extract_audio(path, work_dir):
    """Mono 16kHz WAV — what both faster-whisper and openSMILE expect."""
    audio_path = os.path.join(work_dir, "audio.wav")
    result = subprocess.run(
        [_ffmpeg_path(), "-y", "-i", path, "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1", audio_path],
        capture_output=True,
    )
    if result.returncode != 0 or not os.path.exists(audio_path):
        return None  # clip has no audio track (or ffmpeg failed) — callers treat this as "no speech"
    return audio_path
