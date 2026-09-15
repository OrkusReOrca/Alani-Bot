"""Eye Gaze (ET) and Head Pose (HT) — thresholds, wording, and formatting
ported verbatim from the JAIST pipeline's own part_pose_loaders.py
(load_eye_string()/load_head_string()). All threshold constants below are
copied exactly from that file's _THR dict.

Adaptation note (same reasoning as extract_au.py): the original read
precomputed pose_features.json (from PyFeat's img2pose + L2CS-Net, run
once offline for the whole dataset). This extracts head pose live via
the shared py-feat detector (detector.py, face_model="img2pose" — the
same model the original used), converting its degrees to radians so the
thresholds below apply unchanged. Gaze comes from py-feat's default
gaze_model ("l2cs", the same L2CS-Net the original used) on that same
detection pass — its exact output column names weren't confirmed ahead
of time, so this tries a couple of plausible candidates and degrades
gracefully to "not available" (matching the original code's own handling
of missing pose data) rather than guessing at a name that turns out
wrong, which would silently feed nonsense into the prompt.
"""

import math

_THR = {
    "gaze_x_center": 0.262,
    "gaze_y_center": 0.209,
    "gaze_shift": 0.209,
    "head_pitch_down": -0.262,
    "head_pitch_up": 0.140,
    "head_yaw_turn": 0.314,
    "head_roll_tilt": 0.175,
    "head_move_low": 0.140,
    "head_move_high": 0.349,
}

def _deg_to_rad(v):
    return v * math.pi / 180.0 if v is not None else None


def extract_pose_features(result):
    """Takes the shared py-feat Fex dataframe (see detector.py), returns
    a dict with whatever of head_pitch_mean/std, head_yaw_mean/std,
    head_roll_mean/std, head_movement_range, gaze_x_mean/std, gaze_y_mean/std
    could actually be extracted (radians) — missing keys mean "not available",
    same as the original's missing-pose-file case."""
    out = {}
    for col, key in (("Pitch", "head_pitch"), ("Yaw", "head_yaw"), ("Roll", "head_roll")):
        if col not in result.columns:
            continue
        series = result[col].dropna().apply(_deg_to_rad)
        if len(series) == 0:
            continue
        out[f"{key}_mean"] = float(series.mean())
        out[f"{key}_std"] = float(series.std()) if len(series) > 1 else 0.0

    if "head_pitch_mean" in out:
        pitch_series = result["Pitch"].dropna().apply(_deg_to_rad)
        if len(pitch_series):
            out["head_movement_range"] = float(pitch_series.max() - pitch_series.min())

    # Best-effort: only a subset of py-feat installs/versions expose gaze
    # columns. Try the common naming, otherwise leave gaze out entirely.
    for src_x, src_y in (("gaze_angle_x", "gaze_angle_y"), ("AU_gaze_x", "AU_gaze_y")):
        if src_x in result.columns and src_y in result.columns:
            gx = result[src_x].dropna()
            gy = result[src_y].dropna()
            if len(gx):
                out["gaze_x_mean"] = float(gx.mean())
                out["gaze_x_std"] = float(gx.std()) if len(gx) > 1 else 0.0
            if len(gy):
                out["gaze_y_mean"] = float(gy.mean())
                out["gaze_y_std"] = float(gy.std()) if len(gy) > 1 else 0.0
            break

    return out


def _ql_gaze_h(val):
    if val is None:
        return "unknown"
    if val < -_THR["gaze_x_center"]:
        return "avoidant left"
    if val > _THR["gaze_x_center"]:
        return "avoidant right"
    return "centered"


def _ql_gaze_v(val):
    if val is None:
        return "unknown"
    if val < -_THR["gaze_y_center"]:
        return "downward"
    if val > _THR["gaze_y_center"]:
        return "upward"
    return "neutral"


def _ql_pitch(val):
    if val is None:
        return "unknown"
    if val < _THR["head_pitch_down"]:
        return "lowered"
    if val > _THR["head_pitch_up"]:
        return "raised"
    return "neutral"


def _ql_yaw(val):
    if val is None:
        return "unknown"
    if val < -_THR["head_yaw_turn"]:
        return "turned left"
    if val > _THR["head_yaw_turn"]:
        return "turned right"
    return "near center"


def _ql_roll(val):
    if val is None:
        return "unknown"
    if val < -_THR["head_roll_tilt"]:
        return "tilted right"
    if val > _THR["head_roll_tilt"]:
        return "tilted left"
    return "near neutral"


def _ql_movement(rng, std):
    if rng is None and std is None:
        return "unknown"
    val = rng if rng is not None else (std * 3 if std is not None else 0)
    if val < _THR["head_move_low"]:
        return "very still"
    if val > _THR["head_move_high"]:
        return "active / high movement"
    return "moderate movement"


def format_eye_string(feat):
    gx_mean, gx_std = feat.get("gaze_x_mean"), feat.get("gaze_x_std")
    gy_mean, gy_std = feat.get("gaze_y_mean"), feat.get("gaze_y_std")
    if gx_mean is None and gy_mean is None:
        return ""

    lines = ["Eye gaze:"]
    if gx_mean is not None:
        ql = _ql_gaze_h(gx_mean)
        stab = f", variation={gx_std:.3f} rad" if gx_std is not None else ""
        shifting = " [shifting]" if (gx_std is not None and gx_std > _THR["gaze_shift"]) else " [stable]"
        lines.append(f"  Horizontal (left/right): {gx_mean:+.3f} rad [{ql}]{stab}{shifting}")
    if gy_mean is not None:
        ql = _ql_gaze_v(gy_mean)
        stab = f", variation={gy_std:.3f} rad" if gy_std is not None else ""
        lines.append(f"  Vertical (up/down):      {gy_mean:+.3f} rad [{ql}]{stab}")

    avoiding = (gx_mean is not None and abs(gx_mean) > _THR["gaze_x_center"]) or (
        gx_std is not None and gx_std > _THR["gaze_shift"]
    )
    lines.append(f"  Avoidance: {'YES — gaze is off-center or shifting' if avoiding else 'NO — steady, centered gaze'}")
    lines.append("  Note: gaze avoidance is associated with stress (NA) or withdrawal (ND).")
    return "\n".join(lines)


def format_head_string(feat):
    p_mean, p_std = feat.get("head_pitch_mean"), feat.get("head_pitch_std")
    y_mean, y_std = feat.get("head_yaw_mean"), feat.get("head_yaw_std")
    r_mean, r_std = feat.get("head_roll_mean"), feat.get("head_roll_std")
    mv_rng = feat.get("head_movement_range")
    if p_mean is None and y_mean is None:
        return ""

    lines = ["Head pose:"]
    if p_mean is not None:
        ql = _ql_pitch(p_mean)
        stab = f", variation={p_std:.3f} rad" if p_std is not None else ""
        lines.append(f"  Pitch (nod up/down):   {p_mean:+.3f} rad [{ql}]{stab}")
    if y_mean is not None:
        ql = _ql_yaw(y_mean)
        stab = f", variation={y_std:.3f} rad" if y_std is not None else ""
        lines.append(f"  Yaw (turn left/right): {y_mean:+.3f} rad [{ql}]{stab}")
    if r_mean is not None:
        ql = _ql_roll(r_mean)
        stab = f", variation={r_std:.3f} rad" if r_std is not None else ""
        lines.append(f"  Roll (side tilt):      {r_mean:+.3f} rad [{ql}]{stab}")

    lines.append(f"  Overall movement: {_ql_movement(mv_rng, p_std)}")
    lines.append("  Note: if head pose conflicts with what you observe in the video, trust the video.")
    return "\n".join(lines)
