"""Action Units (AU) — ported from the JAIST pipeline's own
part_flex_flex_au_formatter.py, specifically format_au_string()'s output
shape and wording ("AU06 Cheek Raiser: 4.19 (present)", "; "-joined).

Two real adaptations from the original:

1. That code aggregated AU values from a precomputed OpenFace-produced
   CSV (columns "AUxx_r"/"AUxx_c", already extracted offline for the
   whole 2107-clip dataset ahead of time). This service extracts AUs
   live, per clip, via py-feat's Detectorv1 (see detector.py) — OpenFace
   itself is a heavy C++ binary with no simple pip install, exactly the
   kind of native-build risk this project has been avoiding on
   bot-hosting.net throughout.

2. py-feat's default AU model ("xgb") outputs continuous values on a
   0-1 scale, not OpenFace's original 0-5 intensity scale that
   methodology.txt and every threshold/wording in this pipeline assumes.
   Rather than rewrite the whole prompt vocabulary around a different
   scale, values are linearly rescaled ×5 here (0-1 -> 0-5) before
   formatting, and the "present" threshold stays 1.0 on that same
   rescaled 0-5 scale — an honest, documented adaptation, not a silent
   mismatch.
"""

_AU_NAMES = {
    "AU01": "Inner Brow Raiser", "AU02": "Outer Brow Raiser", "AU04": "Brow Lowerer",
    "AU05": "Upper Lid Raiser", "AU06": "Cheek Raiser", "AU07": "Lid Tightener",
    "AU09": "Nose Wrinkler", "AU10": "Upper Lip Raiser", "AU12": "Lip Corner Puller",
    "AU14": "Dimpler", "AU15": "Lip Corner Depressor", "AU17": "Chin Raiser",
    "AU20": "Lip Stretcher", "AU23": "Lip Tightener", "AU25": "Lips Part",
    "AU26": "Jaw Drop", "AU28": "Lip Suck", "AU45": "Blink",
}
_PRESENT_THRESHOLD = 1.0  # on the rescaled 0-5 display scale
_RAW_TO_DISPLAY_SCALE = 5.0  # py-feat's xgb au_model outputs 0-1; rescale to 0-5


def extract_au_values(result):
    """Takes the shared py-feat Fex dataframe (see detector.py), returns
    {'AU06': 4.19, ...} — mean intensity across frames, rescaled to 0-5,
    only for AUs in _AU_NAMES, missing/NaN treated as 0.0 (same as the
    original treating NaN as absent)."""
    values = {}
    for au in _AU_NAMES:
        if au not in result.columns:
            continue
        series = result[au].dropna()
        raw_mean = float(series.mean()) if len(series) else 0.0
        values[au] = raw_mean * _RAW_TO_DISPLAY_SCALE
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
