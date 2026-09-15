"""Voice Acoustics (VO) — ported verbatim (wording, formula, formatting)
from the JAIST pipeline's own run_phase2j_qwen3_VATVOETHT_ValAro.py,
_load_voice_string(). Only the source of the raw numbers changed: the
original read a precomputed voice_features.json; this extracts live via
opensmile-python's eGeMAPSv02 functionals, which uses the exact same
standardized column names (it's a fixed, standardized feature set), so
the formulas below apply unchanged.
"""

_smile = None


def _get_smile():
    global _smile
    if _smile is None:
        import opensmile

        _smile = opensmile.Smile(
            feature_set=opensmile.FeatureSet.eGeMAPSv02,
            feature_level=opensmile.FeatureLevel.Functionals,
        )
    return _smile


def _semitone_to_hz(v):
    try:
        return 27.5 * (2 ** (v / 12.0))
    except Exception:
        return None


def extract_voice_features(audio_path):
    """Returns the raw eGeMAPS functionals as a plain dict, or {} if the
    clip has no usable audio (caller falls back to '(not available)')."""
    if not audio_path:
        return {}
    try:
        df = _get_smile().process_file(audio_path)
    except Exception:
        return {}
    if df.empty:
        return {}
    row = df.iloc[0]
    return row.to_dict()


def format_voice_string(features):
    if not features:
        return ""

    def g(k):
        return features.get(k)

    lines = ["Voice acoustics (eGeMAPS):"]
    f0 = g("F0semitoneFrom27.5Hz_sma3nz_amean")
    f0v = g("F0semitoneFrom27.5Hz_sma3nz_stddevNorm")
    if f0:
        hz = _semitone_to_hz(f0)
        line = f"  Pitch: {hz:.0f} Hz" if hz is not None else ""
        if line and f0v:
            line += f", variation={f0v * 100:.1f}%"
        if line:
            lines.append(line)

    loud = g("loudness_sma3_amean")
    if loud:
        lines.append(f"  Loudness: {loud:.3f} sone")

    vps = g("VoicedSegmentsPerSec")
    if vps:
        lines.append(f"  Rate: {vps:.2f} seg/sec")

    jitter = g("jitterLocal_sma3nz_amean")
    hnr = g("HNRdBACF_sma3nz_amean")
    vq = []
    if jitter:
        vq.append(f"jitter={jitter * 100:.2f}%")
    if hnr:
        vq.append(f"HNR={hnr:.1f} dB")
    if vq:
        lines.append(f"  Quality: {', '.join(vq)}")

    return "\n".join(lines) if len(lines) > 1 else ""
