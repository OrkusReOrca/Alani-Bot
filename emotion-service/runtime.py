"""Process-wide state shared by every way of starting work on this slot.

`heavy_lock` is the single most important object here. torch + py-feat +
faster-whisper + openSMILE together are the RAM risk of this deployment, so
exactly ONE heavy analysis runs at a time — whether it was started from
Discord (pipeline.run_clips, the Drive flow) or from the web dashboard
(web_jobs.py). Both take this lock around the actual work (core.process), so
the two paths can never overlap and a second detector is never loaded.

The warm-up flags let the dashboard show "Models: cold / warming / ready" and
let a "Warm up models" press load the heavy models ahead of the first real
clip (the first run otherwise pays for torch/py-feat/whisper start-up).
"""

import threading

heavy_lock = threading.Lock()

# "cold" -> "warming" -> "ready" (or "failed", with the reason kept for the UI)
_warm_lock = threading.Lock()
_warm = {"state": "cold", "error": None}


def warm_state():
    with _warm_lock:
        return dict(_warm)


def _set_warm(state, error=None):
    with _warm_lock:
        _warm["state"] = state
        _warm["error"] = error


def warm_up(loader):
    """Runs `loader()` (which imports/loads the heavy models) under the heavy
    lock, tracking the state. No-op if already warm or already warming.
    Returns True if this call started the warm-up."""
    with _warm_lock:
        if _warm["state"] in ("warming", "ready"):
            return False
        _warm["state"], _warm["error"] = "warming", None

    def work():
        try:
            with heavy_lock:
                loader()
            _set_warm("ready")
        except Exception as e:  # a failed warm-up must never take the service down
            _set_warm("failed", str(e)[:300])

    threading.Thread(target=work, daemon=True, name="warm-up").start()
    return True


def mark_ready():
    """A real analysis just loaded the models — no separate warm-up needed."""
    _set_warm("ready")
