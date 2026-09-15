"""ValAro two-step prompt builder — ported verbatim (wording, structure)
from the JAIST pipeline's own run_phase2j_qwen3_VATVOETHT_ValAro.py:
build_prompt_valence()/build_prompt_arousal()/_parse_valence()/
_parse_arousal()/_combine(). max_new_tokens=8 for both steps, matching
that script's actual calls (not the "16" the methodology summary doc
claims — the real code is the source of truth here).

One deliberate generalization: the source script always built all 5
modality blocks (it was one of several fixed-combo variant scripts). This
command lets the caller choose which modalities go in the prompt at all
(the m<list> argument), so _modality_body() below only includes blocks
for modalities actually requested — not "(not available)" placeholders
for ones that were never asked for. A requested-but-failed-to-extract
modality still gets its "(not available)" fallback line, exactly like
the original.
"""

_COMBINE = {
    ("positive", "active"): "Positive_Activate",
    ("positive", "deactivate"): "Positive_Deactivate",
    ("negative", "active"): "Negative_Activate",
    ("negative", "deactivate"): "Negative_Deactivate",
}
SHORT_CODE = {
    "Positive_Activate": "PA",
    "Negative_Activate": "NA",
    "Negative_Deactivate": "ND",
    "Positive_Deactivate": "PD",
}


def _modality_body(modalities, au_string, transcript, voice_string, eye_string, head_string):
    blocks = []
    if "AU" in modalities:
        blocks.append(f"Facial AU data:\n{au_string.strip() or 'No AU data available.'}")
    if "T" in modalities:
        blocks.append(
            f'Speech transcript: "{transcript}"\nNote: if garbled, disregard it.'
            if transcript
            else "Speech transcript: (not available)"
        )
    if "VO" in modalities:
        blocks.append(f"{voice_string}\nNote: trust video if voice conflicts." if voice_string else "Voice: (not available)")
    if "ET" in modalities:
        blocks.append(eye_string or "Eye gaze: (not available)")
    if "HT" in modalities:
        blocks.append(head_string or "Head pose: (not available)")
    return "\n\n".join(blocks)


def build_prompt_valence(modalities, au_string, transcript, voice_string, eye_string, head_string):
    body = _modality_body(modalities, au_string, transcript, voice_string, eye_string, head_string)
    return (
        "You are analyzing a person's facial expression, body language, speech, "
        "voice acoustics, eye gaze, and head pose in an online video call clip.\n\n"
        "TASK: Determine the VALENCE (emotional tone) of this person's state.\n\n"
        "  positive — the person feels good, pleasant, or at ease\n"
        "  negative — the person feels bad, unpleasant, or distressed\n\n"
        f"{body}\n\n"
        "Respond with ONLY one word: 'positive' or 'negative'. "
        "Do not explain. Do not add punctuation."
    )


def build_prompt_arousal(valence, modalities, au_string, transcript, voice_string, eye_string, head_string):
    body = _modality_body(modalities, au_string, transcript, voice_string, eye_string, head_string)
    val_ctx = (
        "The person's emotional tone has already been determined to be "
        f"{'POSITIVE' if valence == 'positive' else 'NEGATIVE'}.\n\n"
    )
    return (
        "You are analyzing a person's facial expression, body language, speech, "
        "voice acoustics, eye gaze, and head pose in an online video call clip.\n\n"
        f"{val_ctx}"
        "TASK: Determine the AROUSAL (energy level) of this person's state.\n\n"
        "  active     — high energy, animated, tense, or expressive\n"
        "  deactivate — low energy, calm, subdued, or still\n\n"
        f"{body}\n\n"
        "Respond with ONLY one word: 'active' or 'deactivate'. "
        "Do not explain. Do not add punctuation."
    )


def parse_valence(raw):
    t = raw.strip().lower()
    if "negative" in t:
        return "negative"
    if "positive" in t:
        return "positive"
    return "positive"


def parse_arousal(raw):
    t = raw.strip().lower()
    if "deactivat" in t or "calm" in t or "low" in t:
        return "deactivate"
    if "active" in t or "high" in t:
        return "active"
    return "deactivate"


def combine(valence, arousal):
    return _COMBINE.get((valence, arousal), "Positive_Deactivate")
