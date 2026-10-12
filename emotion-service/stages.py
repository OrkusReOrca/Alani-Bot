"""Stage vocabulary and progress meter shared by the real analysis (core.py)
and the dev stand-in (fake_pipeline.py). Deliberately free of any heavy
import so the web layer and its tests load without torch/py-feat/cv2.
"""

import time

ALL_MODALITIES = ["AU", "T", "VO", "ET", "HT"]

# Rough share of a full run each stage takes. Only used to turn "which stages
# are actually going to run" into a progress percentage — never shown as time.
STAGE_WEIGHTS = {
    "truncating": 2,
    "frames": 6,
    "face": 30,
    "finalizing": 8,
    "audio": 4,
    "transcript": 20,
    "voice": 6,
    "vlm_valence": 12,
    "vlm_arousal": 12,
}
STAGE_ORDER = list(STAGE_WEIGHTS)


class Meter:
    """Tracks which stages will run, which are done, and the percentage."""

    def __init__(self, progress, planned, cached=None):
        self._progress = progress or (lambda *args, **kwargs: None)
        # Seconds the stages we are about to reuse originally took (from earlier runs of this clip).
        self.cached = dict(cached or {})
        self.planned = {s: STAGE_WEIGHTS[s] for s in planned}
        self.total = sum(self.planned.values()) or 1
        self.done_weight = 0
        self.status = {s: "pending" for s in STAGE_ORDER}
        self.timings = {}
        self._started = {}

    def _percent(self):
        return round(100 * self.done_weight / self.total, 1)

    def skip(self, stage, why):
        self.status[stage] = why  # "cached" (already had it) or "skipped" (not asked for)

    def _report(self, stage, detail):
        self._progress(stage, detail, percent=self._percent(), status=dict(self.status), timings=dict(self.timings), cached=dict(self.cached))

    def begin(self, stage, detail):
        self._started[stage] = time.monotonic()
        self._report(stage, detail)

    def note(self, stage, detail):
        """Change the sentence shown for a running stage (e.g. "busy, retrying in 20 s") without touching its timer."""
        self._report(stage, detail)

    def end(self, stage):
        self.timings[stage] = round(time.monotonic() - self._started[stage], 2)
        self.status[stage] = "done"
        self.done_weight += self.planned.get(stage, 0)


class Plan:
    """What a run has to do, given what is already cached. One source of truth
    for core.py (the real analysis) and fake_pipeline.py (the dev stand-in)."""

    def __init__(self, cache, modalities, cache_mode, want_annotated, have_frames, have_annotated):
        extract_set = ALL_MODALITIES if cache_mode == "d" else modalities
        self.extract_set = extract_set
        self.need_frames = not (have_frames and "clip_meta" in cache)
        # One shared py-feat pass covers AU and eye/head-pose — only run it if
        # one of them (or the annotated frame) still needs it.
        self.needs_au = "AU" in extract_set and "au_string" not in cache
        self.needs_pose = ("ET" in extract_set or "HT" in extract_set) and ("eye_string" not in cache or "head_string" not in cache)
        # A drawing that failed once is not retried by re-running the whole face pass for it.
        self.needs_annotation = want_annotated and not have_annotated and not cache.get("annotated_failed")
        self.cache_seconds = dict(cache.get("stage_seconds", {}))
        self.need_detection = self.needs_au or self.needs_pose or self.needs_annotation
        self.need_transcript = "T" in extract_set and "transcript" not in cache
        self.need_voice = "VO" in extract_set and "voice_string" not in cache
        self.needs_audio = self.need_transcript or self.need_voice
        self.need_working_video = self.need_frames or self.needs_audio

        wanted = {
            "truncating": True,
            "frames": True,
            "face": any(m in extract_set for m in ("AU", "ET", "HT")),
            "audio": "T" in extract_set or "VO" in extract_set,
            "transcript": "T" in extract_set,
            "voice": "VO" in extract_set,
            "finalizing": want_annotated,
        }
        runs = {
            "truncating": self.need_working_video,
            "frames": self.need_frames,
            "face": self.need_detection,
            "audio": self.needs_audio,
            "transcript": self.need_transcript,
            "voice": self.need_voice,
            "finalizing": self.needs_annotation,
            "vlm_valence": True,
            "vlm_arousal": True,
        }
        self.stages = [s for s in STAGE_ORDER if runs[s]]
        # Stages that will not run: "cached" if the run wanted them but already had them, else "skipped".
        self.unplanned = {s: ("cached" if wanted[s] else "skipped") for s in STAGE_ORDER if not runs[s]}

    def meter(self, progress):
        reused = {s: self.cache_seconds[s] for s, why in self.unplanned.items() if why == "cached" and s in self.cache_seconds}
        meter = Meter(progress, self.stages, cached=reused)
        for stage, why in self.unplanned.items():
            meter.skip(stage, why)
        return meter
