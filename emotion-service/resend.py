"""".a emo resend <all|recent|<filename>>" — re-posts already-computed
results without touching Drive, preprocessing, or OpenRouter at all.
Exists specifically for the case a run finished successfully (clip
marked DONE_, prediction computed and cached) but the final callback to
Alani-Bot never arrived — a real failure mode seen in practice: the
inter-container network path had a transient reset right at that last
step. Recomputing everything just to redeliver a result Alani Emotion
already has on disk would be wasteful; this just re-reads store.py's own
records and re-sends.
"""

import prompt
import store
import callback


def run(target, invoked_by):
    rows = store.find_resend_targets(target)

    sent = 0
    for row in rows:
        file_id = row["file_id"]
        filename = row["filename"]
        prediction = row.get("prediction", "")
        short = prompt.SHORT_CODE.get(prediction, prediction)
        label = f"{prediction} ({short})" if prediction else "(no prediction on record)"
        first_frame_path = store.load_first_frame(file_id)
        # Only present if that run used "more info" mode (see pipeline.py)
        # — resend just replays whatever was actually cached, it doesn't
        # reconstruct a prompt that was never saved.
        cache = store.load_clip_cache(file_id)
        if callback.post_result(
            filename, True, prediction=label, first_frame_path=first_frame_path,
            valence_prompt=cache.get("last_valence_prompt"),
            arousal_prompt=cache.get("last_arousal_prompt"),
            timeline=cache.get("last_timeline"), resent=True,
        ):
            sent += 1

    callback.post("/emotion/batch-done", {"total": len(rows), "succeeded": sent, "failed": len(rows) - sent})
