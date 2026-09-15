"""Calls OpenRouter's OpenAI-compatible chat completions endpoint for
qwen/qwen3-vl-8b-instruct. Confirmed via OpenRouter's own
/api/v1/models/.../endpoints response that this hosted endpoint's
input_modalities are ["image","text"] only — no "video" — unlike the
source pipeline's locally-loaded transformers model, which took a raw
video file directly. So frames extracted by video.py are sent here as an
ordered list of image_url blocks (frames first, then the text prompt),
approximating the same "sampled frames + text" input the original model
saw.
"""

import base64

import requests

import config

_API_URL = "https://openrouter.ai/api/v1/chat/completions"


def _frame_to_data_uri(frame_path):
    with open(frame_path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("ascii")
    return f"data:image/jpeg;base64,{b64}"


def classify(frame_paths, prompt_text, max_tokens=8):
    """Sends the frames + prompt, returns the raw decoded response text.
    Raises on a non-2xx response — callers (pipeline.py) are expected to
    catch and report per-clip failures rather than crash the whole run."""
    if not config.OPENROUTER_API_KEY:
        raise RuntimeError("OPENROUTER_API_KEY not configured")

    content = [{"type": "image_url", "image_url": {"url": _frame_to_data_uri(p)}} for p in frame_paths]
    content.append({"type": "text", "text": prompt_text})

    response = requests.post(
        _API_URL,
        headers={"Authorization": f"Bearer {config.OPENROUTER_API_KEY}", "Content-Type": "application/json"},
        json={
            "model": config.OPENROUTER_MODEL,
            "messages": [{"role": "user", "content": content}],
            "max_tokens": max_tokens,
        },
        timeout=120,
    )
    if not response.ok:
        raise RuntimeError(f"OpenRouter call failed: {response.status_code} {response.text[:500]}")

    data = response.json()
    return data["choices"][0]["message"]["content"].strip()
