# Alani Emotion

**Two ways to use it, one at a time on the slot:**

1. **Web dashboard** (the thesis demo) — set `DEMO_PASSWORD` and open `https://<slot>/app/`.
   Upload or record a video, watch a live step-by-step progress bar, read the results.
   How it works and why: [`../ALANI_EMOTION_WEBBOARD.txt`](../ALANI_EMOTION_WEBBOARD.txt).
2. **Discord / Google Drive flow** (the original way, kept as the backup) — leave
   `DEMO_PASSWORD` unset and `.a emo run1|runany|runall|resend` drive it exactly as before.

While the dashboard is on, `POST /run` and `/resend` answer 503 (set
`EMOTION_KEEP_DISCORD_FLOW=1` to keep both on; they still share one heavy-work lock).

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

Web dashboard variables (all optional except `DEMO_PASSWORD`; read in `config.py`):

| Variable | What it's for |
|---|---|
| `DEMO_PASSWORD` | Turns the dashboard on and is its login password. Use a throwaway, unique one. |
| `EMOTION_KEEP_DISCORD_FLOW` | `1` keeps `/run` and `/resend` working while the dashboard is on. Default off. |
| `EMOTION_WEB_SESSION_KEY` | HMAC key for the login cookie. If unset it is derived from the password + `EMOTION_SERVICE_SECRET`, so changing either logs everyone out. |
| `EMOTION_WEB_SESSION_HOURS` | Login lifetime. Default 12. |
| `EMOTION_WEB_MAX_UPLOAD_MB` | Upload size limit. Default 300 — lower it if the host's proxy cuts long uploads. |
| `EMOTION_WEB_RETENTION_HOURS` | Unpinned runs (and their uploaded videos) are deleted after this. Default 24. |
| `EMOTION_WEB_MAX_JOBS_PER_HOUR` | Spend guard against a leaked password. Default 20. |
| `EMOTION_WARMUP_ON_START` | `1` loads the heavy models at boot instead of on the dashboard's "Warm up models" button. |
| `EMOTION_FAKE_PIPELINE` | Dev/test only: a stand-in analysis that needs none of torch / py-feat / whisper (`fake_pipeline.py`). |

`ALANI_BOT_URL` + `EMOTION_SERVICE_SECRET` are also what the dashboard's "Save to Discord" uses.
`OPENROUTER_API_KEY` is only needed when a job reaches the model step (the job fails with a
clear message if it is missing); `GOOGLE_SERVICE_ACCOUNT_KEY` is not needed for the dashboard.

**Startup file for the bot-hosting.net slot:** `emotion-service/main.py`.
The panel's Startup File field defaults to just `main.py` (looked for at
the repo root) — set it explicitly to `emotion-service/main.py`, same as
Alani-Bot's own Node slot uses `src/bot.js`, not `index.js`. `requirements.txt`
at the repo root is a one-line redirect (`-r emotion-service/requirements.txt`)
for the same reason — bot-hosting.net's Python egg only ever checks for it
at the repo root.

## Routes

**Web dashboard** (only when `DEMO_PASSWORD` is set; everything except `/app/*`, `/api/health`,
`/api/session` and `/api/login` needs the signed login cookie):
`GET /app/` (the page) · `GET /api/health` · `GET /api/session` · `POST /api/login|logout` ·
`GET /api/config|status` · `POST /api/warmup` · `POST /api/upload` (raw video body) ·
`GET /api/jobs` · `GET|DELETE /api/jobs/<id>` · `POST /api/jobs/<id>/rerun|pin|save` ·
`GET /api/jobs/<id>/media/<annotated.png|first_frame.jpg|frames/frame_NNN.jpg|input>`.

**Discord / Drive flow** — two, both under `POST`, both requiring `Authorization: Bearer
<EMOTION_SERVICE_SECRET>`:

- **`/run`** `{runMode, modalities, cacheMode, moreInfo, invokedBy}` —
  resolves the clip list from Drive **synchronously** (`pipeline.
  resolve_clips`) and returns it as `clipNames` in the `202` response, so
  Alani-Bot's ack can name what's actually queued, then starts the real
  work (`pipeline.run_clips` — preprocess, call OpenRouter, report each
  result back) on a background thread. `commandAtMs` (Alani-Bot's clock, the T+0 of the
  timeline) is passed through to each result. `moreInfo: true` makes each
  result include the full ValAro prompt text, a timeline (Drive upload time,
  preprocess/VLM offsets), and swaps the attached image
  for py-feat's own annotated frame (`visualize.py`) instead of the plain
  thumbnail.
- **`/resend`** `{target, invokedBy}` — re-posts already-computed results
  with no recompute at all (`resend.py`), reading straight from
  `store.py`'s own records. `target` is `"all"`, `"recent"` (last 24h),
  or a filename. See `../src/features/emotion-detect/README.md`'s own
  "Resend" section for why this exists.

## Code layout

`core.py` is the source-agnostic analysis (video in, prediction out, with progress
reporting and per-step timings); `pipeline.py` is the Drive wrapper around it;
`web_jobs.py` / `web_api.py` / `web_auth.py` / `web/` are the dashboard; `stages.py`
(stage vocabulary + the "what still needs computing" plan), `runtime.py` (the one heavy-work
lock, model warm-up state) and `fake_pipeline.py` (dev stand-in) are shared.

## Tests

No torch / py-feat / whisper / ffmpeg needed (they are stubbed or faked):

```bash
python -m unittest discover -s emotion-service/tests
```

## Demo-day checklist

- [ ] Slot env has `DEMO_PASSWORD`, `EMOTION_SERVICE_SECRET`, `ALANI_BOT_URL`, `OPENROUTER_API_KEY`; the panel's Domains tab shows an active HTTPS address.
- [ ] From the presenting machine open `https://<slot>/api/health` — it must say `{"ok": true}`.
- [ ] Log in at `/app/`, press **Warm up models**, then run one short test clip (this also shows the real step times).
- [ ] Record or upload the real clip at the start of the talk (30–60 s is plenty; only the first 2:00 is analysed).
- [ ] **Pin** the finished run and keep a screen recording of a good run as an offline fallback.
- [ ] After the talk delete runs showing faces; watch the slot's RAM/disk during the first full run.

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
