# Alani Emotion

The Python half of the `.a emo` feature (see
[`../src/features/emotion-detect/README.md`](../src/features/emotion-detect/README.md)
for the Discord-facing command and overall architecture). Runs as its
**own bot-hosting.net deployment**, separate from the main Alani-Bot Node
process — different runtime, different resource profile (this is the
side that actually needs real CPU/RAM for video preprocessing).

Reproduces the JAIST thesis's VLM emotion-recognition pipeline
(Qwen3-VL-8B-Instruct via OpenRouter, circumplex model PA/NA/ND/PD,
ValAro two-step prompting) against clips pulled from a Google Drive
folder, triggered by Discord.

## Setup

```bash
pip install -r requirements.txt
```

Env vars (see each one's own comment in `config.py` for detail):

| Variable | What it's for |
|---|---|
| `EMOTION_SERVICE_SECRET` | Shared secret, both directions — Alani-Bot uses it to start a run, this service uses the same value to authenticate its callbacks. Must match Alani-Bot's own `EMOTION_SERVICE_SECRET`. |
| `EMOTION_LISTEN_PORT` | Falls back to bot-hosting.net's own `SERVER_PORT` if unset. |
| `ALANI_BOT_URL` | Alani-Bot's own bridge server address (its Network tab) — where `/emotion/result` and `/emotion/batch-done` live. |
| `OPENROUTER_API_KEY` | From openrouter.ai — pay-per-token access to `qwen/qwen3-vl-8b-instruct`. |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | The entire downloaded service-account JSON key. Can be the exact same key Alani-Bot's Calendar sync uses — just make sure the **Drive API** is enabled on that Google Cloud project too, and that the folder in `DRIVE_INPUT_FOLDER_PATH` (or one of its parents) is shared with that service account's email (its `client_email` field) as an **Editor**, not just Viewer — `drive.py` renames clips to `DONE_...` on success, which needs write access, not only read. |
| `DRIVE_INPUT_FOLDER_PATH` | Defaults to `Alani/Emotion prediction/Input`. |
| `EMOTION_DATA_DIR` | Where the per-clip cache JSONs + the status/history CSV live on disk. Defaults to `./data`. |
| `EMOTION_WHISPER_MODEL` / `EMOTION_WHISPER_COMPUTE_TYPE` | faster-whisper model size/precision — defaults to `small`/`int8` (same tier voice-Alani already runs proven on CPU). The original thesis pipeline used a much larger Thai-finetuned model on an HPC GPU node; bump this if transcript quality matters more than speed for a given demo. |

**Startup file for the bot-hosting.net slot:** `emotion-service/main.py`.
The panel's Startup File field defaults to just `main.py` (looked for at
the repo root) — set it explicitly to `emotion-service/main.py`, same as
Alani-Bot's own Node slot uses `src/bot.js`, not `index.js`. `requirements.txt`
at the repo root is a one-line redirect (`-r emotion-service/requirements.txt`)
for the same reason — bot-hosting.net's Python egg only ever checks for it
at the repo root.

## Routes

Two, both under `POST`, both requiring `Authorization: Bearer
<EMOTION_SERVICE_SECRET>`:

- **`/run`** `{runMode, modalities, cacheMode, invokedBy}` — starts a
  real run (`pipeline.py`): lists clips from Drive, preprocesses, calls
  OpenRouter, reports each result back to Alani-Bot. Returns `202`
  immediately; the actual work happens on a background thread.
- **`/resend`** `{target, invokedBy}` — re-posts already-computed results
  with no recompute at all (`resend.py`), reading straight from
  `store.py`'s own records. `target` is `"all"`, `"recent"` (last 24h),
  or a filename. See `../src/features/emotion-detect/README.md`'s own
  "Resend" section for why this exists.

## Why no OpenFace, and no local model weights

Every extractor here (`extract_au.py`, `extract_voice.py`,
`extract_pose.py`, `extract_transcript.py`) is pip-installable with no
native compile step — deliberately, since this repo has already hit
bot-hosting.net's native-module-build wall once (`canvas`, see the root
README's "Daily jobs" section). `py-feat` stands in for the original
pipeline's OpenFace + PyFeat combination for exactly this reason. See
each extractor's own module docstring for the specific adaptation made
and why.

## Storage

Everything this feature persists lives here, on this deployment's own
disk (`EMOTION_DATA_DIR`) — see `store.py`. Nothing goes into Alani-Bot's
SQLite.
