"""Calls OpenRouter's OpenAI-compatible chat completions endpoint for
qwen/qwen3-vl-8b-instruct. Confirmed via OpenRouter's own
/api/v1/models/.../endpoints response that this hosted endpoint's
input_modalities are ["image","text"] only — no "video" — unlike the
source pipeline's locally-loaded transformers model, which took a raw
video file directly. So frames extracted by video.py are sent here as an
ordered list of image_url blocks (frames first, then the text prompt),
approximating the same "sampled frames + text" input the original model
saw.

OpenRouter forwards each request to a hosting company, whose shared capacity
can be momentarily full ("rate-limited"). Such failures are marked retryable;
the web dashboard's "retry automatically" option keeps asking until it works.
"""

import base64
import json
import time

import requests

import config

_API_URL = "https://openrouter.ai/api/v1/chat/completions"

# Statuses that mean "busy / hiccup, ask again" rather than "your request is wrong".
_RETRYABLE_STATUS = {408, 409, 425, 429, 500, 502, 503, 504, 520, 522, 524, 529}


class OpenRouterError(RuntimeError):
    """A failed call. `retryable` is True for "busy, try again" kinds of failure
    (rate limit, overloaded provider, timeout) and False for ones that will not
    fix themselves (bad key, no credit, rejected request)."""

    def __init__(self, message, retryable=False):
        super().__init__(message)
        self.retryable = retryable


def _frame_to_data_uri(frame_path):
    with open(frame_path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("ascii")
    return f"data:image/jpeg;base64,{b64}"


def _describe_failure(response):
    """One readable sentence from OpenRouter's error body, which nests the
    hosting company's own message (and name) inside JSON."""
    provider, message = "", ""
    try:
        error = response.json().get("error", {})
        message = str(error.get("message", ""))
        provider = str((error.get("metadata") or {}).get("provider_name", ""))
    except Exception:
        message = response.text[:200]
    if response.status_code == 429:
        by = f" by {provider}" if provider else ""
        return f"The model provider is busy: the request was rate-limited{by} (OpenRouter 429)."
    if response.status_code in (401, 403):
        return "OpenRouter refused the API key (check OPENROUTER_API_KEY on the server)."
    if response.status_code == 402:
        return "OpenRouter says the account is out of credit."
    return f"OpenRouter answered {response.status_code}: {message[:200] or 'no details'}"


def _call(frame_paths, prompt_text, max_tokens):
    """One request. Raises OpenRouterError (with .retryable) on any failure."""
    content = [{"type": "image_url", "image_url": {"url": _frame_to_data_uri(p)}} for p in frame_paths]
    content.append({"type": "text", "text": prompt_text})

    try:
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
    except requests.RequestException as e:
        raise OpenRouterError(f"Could not reach OpenRouter ({type(e).__name__}).", retryable=True)
    if not response.ok:
        raise OpenRouterError(_describe_failure(response), retryable=response.status_code in _RETRYABLE_STATUS)

    try:
        return response.json()["choices"][0]["message"]["content"].strip()
    except (KeyError, IndexError, TypeError, AttributeError, json.JSONDecodeError):
        # OpenRouter sometimes answers 200 with an error body or no choices when the provider hiccuped.
        raise OpenRouterError("OpenRouter returned no answer (the provider hiccuped).", retryable=True)


def classify(frame_paths, prompt_text, max_tokens=8, retry_until=None, on_wait=None, sleep=time.sleep):
    """Sends the frames + prompt, returns the raw decoded response text.
    Raises on failure — callers (pipeline.py) are expected to catch and report
    per-clip failures rather than crash the whole run.

    `retry_until` (epoch seconds) turns on automatic retrying: while the failure is
    a "busy, try again" one and the deadline has not passed, wait (4 s, 8 s, ... at
    most 30 s) and ask again; `on_wait(attempt, seconds, reason)` is told before each
    wait. Without it (the Discord flow) there is exactly one attempt, as before."""
    if not config.OPENROUTER_API_KEY:
        raise RuntimeError("OPENROUTER_API_KEY not configured")

    attempt = 0
    while True:
        try:
            return _call(frame_paths, prompt_text, max_tokens)
        except OpenRouterError as e:
            if not e.retryable or retry_until is None or time.time() >= retry_until:
                raise
            attempt += 1
            wait = min(30, 4 * 2 ** (attempt - 1))
            if on_wait:
                on_wait(attempt, wait, str(e))
            sleep(wait)
