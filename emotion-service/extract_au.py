"""Action Units (AU) — ported from the JAIST pipeline's own
part_flex_flex_au_formatter.py, specifically format_au_string()'s output
shape and wording ("AU06 Cheek Raiser: 4.19 (present)", "; "-joined).

One real adaptation from the original: that code aggregated AU values
from a precomputed OpenFace-produced CSV (columns "AUxx_r"/"AUxx_c",
already extracted offline for the whole 2107-clip dataset ahead of time).
This service extracts AUs live, per clip, from the same sampled frames
used for the VLM prompt, via py-feat's own Detector — OpenFace itself is
a heavy C++ binary with no simple pip install, which is exactly the kind
of native-build risk this project has been avoiding on bot-hosting.net
throughout. py-feat doesn't expose OpenFace's separate binary "present"
flag, so presence here is threshold-based (mean intensity >= 1.0) instead
of the original's majority-of-frames vote — same effective meaning
("clearly active over the clip"), same threshold value the original code
used as its OWN fallback when a presence column was missing.
"""

_AU_NAMES = {
    "AU01": "Inner Brow Raiser", "AU02": "Outer Brow Raiser", "AU04": "Brow Lowerer",
    "AU05": "Upper Lid Raiser", "AU06": "Cheek Raiser", "AU07": "Lid Tightener",
    "AU09": "Nose Wrinkler", "AU10": "Upper Lip Raiser", "AU12": "Lip Corner Puller",
    "AU14": "Dimpler", "AU15": "Lip Corner Depressor", "AU17": "Chin Raiser",
    "AU20": "Lip Stretcher", "AU23": "Lip Tightener", "AU25": "Lips Part",
    "AU26": "Jaw Drop", "AU28": "Lip Suck", "AU45": "Blink",
}
_PRESENT_THRESHOLD = 1.0

_detector = None


def _get_detector():
    global _detector
    if _detector is None:
        from feat import Detector

        _detector = Detector()
    return _detector


def extract_au_values(frame_paths):
    """Runs py-feat over the given frames, returns {'AU06': 4.19, ...}
    (mean intensity across frames, only for AUs in _AU_NAMES, missing/NaN
    treated as 0.0 — same as the original treating NaN as absent)."""
    detector = _get_detector()
    result = detector.detect_image(frame_paths)

    values = {}
    for au in _AU_NAMES:
        if au not in result.columns:
            continue
        series = result[au].dropna()
        values[au] = float(series.mean()) if len(series) else 0.0
    return values


def format_au_string(au_values):
    """Build the clip-level AU summary string for the VLM prompt, e.g.
    'AU06 Cheek Raiser: 4.19 (present); AU12 Lip Corner Puller: 4.26 (present); ...'."""
    if not au_values:
        return "No Action Units detected."

    parts = []
    for au in sorted(au_values.keys()):
        intensity = au_values[au]
        present = intensity >= _PRESENT_THRESHOLD
        name = _AU_NAMES.get(au, "")
        tag = "present" if present else "absent"
        parts.append(f"{au} {name}: {intensity:.2f} ({tag})")
    return "; ".join(parts) if parts else "No active Action Units."
