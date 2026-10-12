"""core.process() and the Drive wrapper, with every heavy dependency replaced.

The real thing needs torch / py-feat / whisper / ffmpeg, which the dev machine
does not have. These tests stub the leaf modules (cv2, ffmpeg, matplotlib) and
patch the extractors, so what is really exercised is the orchestration: which
stages run, what is cached and reused, and that the Drive flow still logs,
renames and calls back exactly as before.
"""

import os
import shutil
import sys
import tempfile
import types
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

for name in ("cv2", "imageio_ffmpeg", "matplotlib", "matplotlib.pyplot", "feat", "googleapiclient", "googleapiclient.discovery",
             "google", "google.oauth2", "google.oauth2.service_account", "googleapiclient.http"):
    sys.modules.setdefault(name, mock.MagicMock())

import config  # noqa: E402
import core  # noqa: E402
import store  # noqa: E402


def _write(path, data):
    with open(path, "wb") as f:
        f.write(data)


class FakeDetection:
    def __len__(self):
        return 1

    @property
    def iloc(self):
        return self

    def __getitem__(self, item):
        return self


class CoreBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="emotion_core_")
        self.work = os.path.join(self.tmp, "work")
        self.keep = os.path.join(self.tmp, "keep")
        os.makedirs(self.work)
        self._data_dir = config.DATA_DIR
        config.DATA_DIR = os.path.join(self.tmp, "data")
        os.makedirs(config.DATA_DIR)
        store._CLIPS_DIR = store._CSV_PATH = None
        self.src = os.path.join(self.work, "in.mp4")
        _write(self.src, b"video")
        self.calls = {}

        def counted(name, fn):
            def wrapper(*args, **kwargs):
                self.calls[name] = self.calls.get(name, 0) + 1
                return fn(*args, **kwargs)
            return wrapper

        def extract_frames(path, folder):
            os.makedirs(folder, exist_ok=True)
            out = []
            for i in range(3):
                p = os.path.join(folder, f"frame_{i:03d}.jpg")
                _write(p, b"jpg")
                out.append(p)
            return out

        def thumbnail(src, dest, **kwargs):
            _write(dest, b"thumb")
            return dest

        def annotate(row, dest):
            _write(dest, b"png")
            return dest

        self.answers = ["positive", "active"]
        patches = [
            mock.patch.object(core.video, "get_duration_and_frame_count", lambda p: (200.0, 6000)),
            mock.patch.object(core.video, "truncate_if_needed", counted("truncate", lambda p, w: (p, True))),
            mock.patch.object(core.video, "extract_frames", counted("frames", extract_frames)),
            mock.patch.object(core.video, "make_thumbnail", thumbnail),
            mock.patch.object(core.video, "extract_audio", counted("audio", lambda p, w: os.path.join(w, "a.wav"))),
            mock.patch.object(core.detector, "detect_frames", counted("detect", lambda frames: FakeDetection())),
            mock.patch.object(core, "extract_au_values", lambda d: {"AU06": 2.0, "AU12": 3.0}),
            mock.patch.object(core, "extract_pose_features", lambda d: {"head_yaw_mean": 0.1, "gaze_x_mean": 0.0}),
            mock.patch.object(core, "extract_transcript", counted("transcript", lambda a: "hello there")),
            mock.patch.object(core, "extract_voice_features", counted("voice", lambda a: {"x": 1})),
            mock.patch.object(core, "format_voice_string", lambda f: "voice summary"),
            mock.patch.object(core.visualize, "render_annotated_frame", counted("annotate", annotate)),
            mock.patch.object(core, "classify", counted("classify", lambda frames, prompt, max_tokens=8: self.answers[(self.calls["classify"] - 1) % 2])),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.events = []

    def tearDown(self):
        config.DATA_DIR = self._data_dir
        store._CLIPS_DIR = store._CSV_PATH = None
        shutil.rmtree(self.tmp, ignore_errors=True)

    def progress(self, stage, detail=None, percent=None, status=None, timings=None):
        self.events.append((stage, percent))

    def run_core(self, modalities, cache_mode="d", persist=True, annotated=True, more_info=False, clip="web_a"):
        self.calls = {}
        return core.process(clip, self.src, modalities, cache_mode, more_info, self.progress, self.work,
                            persist_dir=self.keep if persist else None, render_annotated=annotated)

class CoreTests(CoreBase):
    def test_full_run_walks_every_stage_and_reports_progress(self):
        result = self.run_core(["AU", "T", "VO", "ET", "HT"])
        self.assertEqual((result["prediction"], result["short"]), ("Positive_Activate", "PA"))
        self.assertEqual([s for s, _ in self.events], ["truncating", "frames", "face", "audio", "transcript", "voice", "vlm_valence", "vlm_arousal", "finalizing"])
        percents = [p for _, p in self.events]
        self.assertEqual(percents, sorted(percents))
        self.assertEqual(percents[0], 0)
        self.assertTrue(all(v == "done" for v in result["stage_status"].values()), result["stage_status"])
        self.assertTrue(result["truncated"])
        self.assertEqual(result["clip_seconds"], config.MAX_CLIP_SECONDS)
        self.assertEqual(result["au_values"], {"AU06": 2.0, "AU12": 3.0})
        self.assertEqual(result["transcript"], "hello there")
        self.assertTrue(os.path.exists(result["files"]["annotated"]))
        self.assertEqual(result["frame_count"], 3)

    def test_a_rerun_with_other_modalities_recomputes_nothing_heavy(self):
        self.run_core(["AU", "T", "VO", "ET", "HT"])
        self.answers = ["negative", "deactivate"]
        result = self.run_core(["T"])
        self.assertEqual(self.calls.get("detect", 0) + self.calls.get("frames", 0) + self.calls.get("transcript", 0) + self.calls.get("audio", 0) + self.calls.get("annotate", 0), 0, self.calls)
        self.assertEqual(self.calls["classify"], 2)
        self.assertEqual(result["short"], "ND")
        self.assertEqual({k: v for k, v in result["stage_status"].items() if v == "cached"}.keys() >= {"frames", "face", "audio", "transcript", "voice", "finalizing"}, True, result["stage_status"])
        self.assertEqual([s for s, _ in self.events[-2:]], ["vlm_valence", "vlm_arousal"])

    def test_cache_mode_s_only_extracts_what_was_asked(self):
        result = self.run_core(["AU"], cache_mode="s", annotated=False)
        self.assertEqual(self.calls.get("transcript", 0) + self.calls.get("voice", 0) + self.calls.get("audio", 0), 0)
        self.assertEqual(result["stage_status"]["transcript"], "skipped")
        self.assertEqual(self.calls["detect"], 1)
        # asking for the transcript later extracts just that
        self.run_core(["AU", "T"], cache_mode="s", annotated=False)
        self.assertEqual((self.calls.get("transcript"), self.calls.get("detect", 0)), (1, 0))

    def test_drive_style_call_without_persist_dir_never_reuses_frames(self):
        self.run_core(["AU"], persist=False, annotated=False, clip="drive1")
        self.assertEqual(self.calls["frames"], 1)
        again = self.run_core(["AU"], persist=False, annotated=False, clip="drive1")
        self.assertEqual(self.calls["frames"], 1)  # frames are per-run scratch for Drive clips
        self.assertIsNone(again["files"]["annotated"])

    def test_more_info_forces_the_annotated_frame_and_keeps_the_prompts(self):
        result = self.run_core(["T"], cache_mode="s", persist=False, annotated=False, more_info=True, clip="drive2")
        self.assertEqual(self.calls["detect"], 1)  # the picture needs a detection even though T alone does not
        self.assertTrue(result["files"]["annotated"])
        cache = store.load_clip_cache("drive2")
        self.assertIn("last_valence_prompt", cache)
        self.assertEqual(cache["last_prediction"], "Positive_Activate")

    def test_prompts_and_raw_answers_are_returned(self):
        result = self.run_core(["AU", "T"])
        self.assertIn("VALENCE", result["valence_prompt"])
        self.assertIn("AROUSAL", result["arousal_prompt"])
        self.assertEqual((result["valence_raw"], result["arousal_raw"]), ("positive", "active"))


class DriveWrapperTests(CoreBase):
    """pipeline._process_clip still does what it did before the refactor: log, rename DONE_, call Alani-Bot back."""

    def test_drive_flow_logs_renames_and_calls_back(self):
        import pipeline
        sent = {}
        with mock.patch.object(pipeline.drive, "download_file", lambda file_id, dest: _write(dest, b"video")),              mock.patch.object(pipeline.drive, "mark_done", lambda file_id, name: sent.update(done=(file_id, name))),              mock.patch.object(pipeline.callback, "post_result", lambda *args, **kwargs: sent.update(result=(args, kwargs)) or True):
            ok = pipeline._process_clip({"id": "F1", "name": "clip.mp4", "createdTime": "2026-09-19T05:12:33.123Z"},
                                        ["AU", "T"], "d", "tester", "run1", True, 1000, __import__("time").time() - 5)
        self.assertTrue(ok)
        self.assertEqual(sent["done"], ("F1", "clip.mp4"))
        args, kwargs = sent["result"]
        self.assertEqual(args[:2], ("clip.mp4", True))
        self.assertEqual(kwargs["prediction"], "Positive_Activate (PA)")
        self.assertIn("VALENCE", kwargs["valence_prompt"])  # more_info: prompts and timeline travel with it
        self.assertEqual(set(kwargs["timeline"]), {"uploadedAtMs", "commandAtMs", "preprocessDoneS", "vlmDoneS"})
        self.assertTrue(kwargs["first_frame_path"].endswith("annotated.png") or os.path.basename(kwargs["first_frame_path"]) in ("annotated.png", "thumb.jpg"))
        rows = store.latest_status_per_clip()
        self.assertEqual(rows["F1"]["status"], "ok")
        self.assertEqual(store.load_clip_cache("F1")["last_timeline"]["commandAtMs"], 1000)
        self.assertIsNotNone(store.load_first_frame("F1"))


class StagesTests(unittest.TestCase):
    def test_plan_marks_unrun_stages_cached_or_skipped(self):
        from stages import Plan
        cache = {"clip_meta": {}, "au_string": "x"}
        plan = Plan(cache, ["AU"], "s", False, ["f"], False)
        self.assertEqual(plan.stages, ["vlm_valence", "vlm_arousal"])
        self.assertEqual(plan.unplanned["face"], "cached")
        self.assertEqual(plan.unplanned["transcript"], "skipped")


if __name__ == "__main__":
    unittest.main()
