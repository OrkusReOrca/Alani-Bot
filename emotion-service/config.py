"""Env-var config for the Alani Emotion service — mirrors the plain
required()-style config.js pattern used throughout the Alani-Bot repo,
just in Python. See emotion-service/README.md for the full setup list.
"""

import os


def _required(name, default=None):
    val = os.environ.get(name, "").strip()
    return val if val else default


# bot-hosting.net sets SERVER_PORT automatically per-deployment — same
# fallback convention as Alani-Bot's own VOICE_API_PORT.
LISTEN_PORT = int(_required("EMOTION_LISTEN_PORT") or _required("SERVER_PORT") or "8000")

# Shared secret, both directions: Alani-Bot -> here to start a run
# (checked on POST /run), and here -> Alani-Bot's own bridge routes to
# report results. Same value on both sides — see Alani-Bot's own
# EMOTION_SERVICE_SECRET.
SHARED_SECRET = _required("EMOTION_SERVICE_SECRET")

# Alani-Bot's own bridge server address (its Network tab), e.g.
# "http://1.2.3.4:5678" — where /emotion/result and /emotion/batch-done
# live.
ALANI_BOT_URL = _required("ALANI_BOT_URL")

# OpenRouter (openrouter.ai) — pay-per-token access to
# qwen/qwen3-vl-8b-instruct, the exact model the JAIST thesis pipeline
# used.
OPENROUTER_API_KEY = _required("OPENROUTER_API_KEY")
OPENROUTER_MODEL = _required("OPENROUTER_MODEL", "qwen/qwen3-vl-8b-instruct")

# The entire downloaded service-account JSON key, as one env var value —
# same convention as Alani-Bot's own GOOGLE_SERVICE_ACCOUNT_KEY (in fact
# this can be the exact same key, as long as the Drive API is enabled on
# that project and the Input folder is shared with its email).
GOOGLE_SERVICE_ACCOUNT_KEY = _required("GOOGLE_SERVICE_ACCOUNT_KEY")

# Where the input videos live, as a "/"-separated path from a folder
# shared with the service account (NOT from "My Drive" root — a service
# account has no My Drive of its own, only what's shared with it). E.g.
# "Alani/Emotion prediction/Input".
DRIVE_INPUT_FOLDER_PATH = _required("DRIVE_INPUT_FOLDER_PATH", "Alani/Emotion prediction/Input")

# Local persistent disk for this deployment — per-clip cache JSON files
# and the single status/history CSV. Per the plan, this IS the "database"
# for this feature; nothing here goes into Alani-Bot's SQLite.
DATA_DIR = _required("EMOTION_DATA_DIR", "./data")

# faster-whisper model size — defaults to the same tier voice-Alani
# already runs proven on CPU (see that repo's ALANI_WHISPER_MODEL). The
# original thesis pipeline used a much larger Thai-finetuned model
# (biodatlab/whisper-th-large-v3-combined) on an HPC GPU node; that's
# almost certainly too slow/heavy for this CPU-only shared slot, so this
# defaults smaller — bump it via env var if quality matters more than
# speed for a given demo.
WHISPER_MODEL = _required("EMOTION_WHISPER_MODEL", "small")
WHISPER_COMPUTE_TYPE = _required("EMOTION_WHISPER_COMPUTE_TYPE", "int8")

MAX_CLIP_SECONDS = 120
MAX_VLM_FRAMES = 32
