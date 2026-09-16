""""more info" mode's annotated frame — py-feat's own Fex.plot_detections()
already draws exactly this style (face box, landmark dots, an AU
intensity bar chart, head pose) directly onto the source image, so this
is a thin wrapper around it rather than hand-rolled cv2 drawing.

emotion_barplot is deliberately off: py-feat's own built-in emotion
classifier is a completely different model from the one this pipeline
actually bases its prediction on (Qwen3-VL via OpenRouter) — showing its
separate, unrelated emotion guess (a "Sad, Conf: 77.7%" style box)
alongside our own VLM-derived prediction would be actively confusing
rather than informative, which is exactly what the reference screenshot
was asked to have stripped out.
"""

import matplotlib

matplotlib.use("Agg")  # headless — no display exists on this host
import matplotlib.pyplot as plt


def render_annotated_frame(detection_row, dest_path):
    """detection_row: a single-row slice of a py-feat Fex result (see
    detector.py) for the one frame being visualized. Saves a PNG to
    dest_path; returns dest_path, or None if plotting failed (a plot
    failure should never take down the whole clip's result — the plain
    thumbnail is always a safe fallback, see pipeline.py)."""
    try:
        result = detection_row.plot_detections(
            faceboxes=True,
            faces="landmarks",
            au_barplot=True,
            emotion_barplot=False,
            poses=True,
            gazes=True,
            plot_original_image=True,
        )
        # plot_detections() has returned either a Figure or an array of
        # Axes across different py-feat versions — handle both rather
        # than guess which one this installed version gives back.
        fig = result if hasattr(result, "savefig") else plt.gcf()
        fig.savefig(dest_path, bbox_inches="tight")
        return dest_path
    except Exception as e:
        print(f"[visualize] plot_detections failed, falling back to plain frame: {e}")
        return None
    finally:
        plt.close("all")  # this is a long-running service — never leak figures across clips
