"""Posts results back to Alani-Bot's own bridge routes — shared by
pipeline.py (fresh results) and resend.py (re-posting already-computed
ones), since both need the exact same "how do I tell Discord about this
clip" logic.

Retries once on failure: the inter-container network path between this
service and Alani-Bot's own Node slot has shown real transient blips
this session (a connection reset mid-callback, after the actual pipeline
work had already succeeded) — a lost prediction is a much worse outcome
than one extra retry.
"""

import base64
import os
import time

import requests

import config


def post(path, payload, retries=1):
    if not config.ALANI_BOT_URL or not config.SHARED_SECRET:
        print(f"[callback] ALANI_BOT_URL/EMOTION_SERVICE_SECRET not set — skipping callback to {path}")
        return False

    for attempt in range(retries + 1):
        try:
            requests.post(
                f"{config.ALANI_BOT_URL.rstrip('/')}{path}",
                headers={"Authorization": f"Bearer {config.SHARED_SECRET}", "Content-Type": "application/json"},
                json=payload,
                timeout=30,
            )
            return True
        except Exception as e:
            if attempt < retries:
                print(f"[callback] {path} failed ({e}) — retrying once")
                time.sleep(2)
            else:
                print(f"[callback] {path} failed after retry: {e}")
    return False


def post_result(
    clip_name, success, prediction=None, error=None, first_frame_path=None,
    valence_prompt=None, arousal_prompt=None,
):
    payload = {"clipName": clip_name, "success": success}
    if success:
        payload["prediction"] = prediction
        if first_frame_path and os.path.exists(first_frame_path):
            with open(first_frame_path, "rb") as f:
                payload["firstFrameBase64"] = base64.b64encode(f.read()).decode("ascii")
        # "more info" mode only — the full prompt text sent to the VLM
        # for this prediction, for transparency into what it actually saw.
        if valence_prompt:
            payload["valencePrompt"] = valence_prompt
        if arousal_prompt:
            payload["arousalPrompt"] = arousal_prompt
    else:
        payload["error"] = error
    return post("/emotion/result", payload)
