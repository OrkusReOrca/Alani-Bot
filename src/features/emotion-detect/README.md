# Emotion Detection

`.a emo <run1|runany|runall> m<modality dot-list|all> <d|s> [mif]` —
triggers a run of the "Alani Emotion" pipeline (a **separate Python
service, not part of this repo's own runtime** — see the root README's
"Emotion detection bridge" section for the full architecture) against
video clips sitting in a Google Drive folder, reproducing the VLM
emotion-recognition pipeline from the user's JAIST thesis
(Qwen3-VL-8B-Instruct, circumplex model: PA/NA/ND/PD). `.a emo resend
<all|recent|<filename>>` re-sends already-computed results with no
recompute at all — see "Resend" below.

Owner-only (`DISCORD_OWNER_0`/`DISCORD_OWNER_1`, same allowlist as `.a
db`), and only responds inside the one dedicated channel
(`DISCORD_EMOTION_CHANNEL`) — silent everywhere else, since this is a
slow, resource-heavy command (real video preprocessing + two VLM calls
per clip), not something meant to be discoverable broadly.

## Command shape

- **Run mode** (first arg):
  - `run1` — process exactly one pending clip (any clip in the Input
    folder not already prefixed `DONE_`)
  - `runany` — process every pending clip found, however many there are
  - `runall` — force-reprocess **every** clip in the folder, `DONE_` or
    not (a full manual re-run)
- **Modality list** (second arg): `m` followed by a dot-separated subset
  of `AU` (Action Units), `T` (speech transcript), `VO` (voice
  acoustics), `ET` (eye gaze), `HT` (head pose) — e.g. `mAU.T.VO` — or
  `mall` for all five. This is what actually goes into the VLM prompt for
  this run.
- **Cache mode** (third arg):
  - `d` (default) — extract and cache **all 5** modalities for this
    clip regardless of what's in the modality list, so a later run
    requesting a different subset is instant (already on disk).
  - `s` (specified-only) — only extract what's in the modality list this
    time, skipping the rest.

- **More info** (fourth arg, optional): `mif` — when present, each
  result comes with the full ValAro prompt text (both the valence and
  arousal steps, exactly as sent to the VLM) as a follow-up message, and
  the attached image is py-feat's own annotated frame (face box,
  landmarks, an AU intensity bar chart, head pose) instead of the plain
  first frame. Left off (the default) keeps today's lighter result.
  Each prompt is its own message (split into several, each with its own
  code fence, only if one alone exceeds Discord's 2000 chars), followed by
  one bullet-point **timeline** message: clip upload time (Drive's
  `createdTime`) and run-command time as `DD/MM/YYYY HH:MM:SS` GMT+7, then
  `T+X` offsets (T+0 = the command) for preprocess finished, VLM inference
  finished, and final message sent.

Example: `.a emo runany mAU.T d` — process every pending clip using only
AU + transcript in the prompt, but cache all five modalities for later.
`.a emo runany mAU.T d mif` — the same, with the extra detail per result.

## What actually happens

This command resolves the actual clip list up front (a fast Drive
listing) so the ack message can name exactly what's queued, then hands
off the slow part. It never waits for the real results inline, since
preprocessing (PyFeat, openSMILE, faster-whisper) plus two sequential VLM
calls per clip can easily take longer than any single Discord command
should block on, especially for `runany`/`runall` across many clips:

1. This command calls Alani Emotion's `POST /run`, which resolves and
   returns the clip list synchronously, then starts the actual
   processing on a background thread. The ack reply then names those
   clips (`"3 clip(s): a.mov, b.mov, c.mov"`, or "no pending clips found").
2. Alani Emotion processes clips one at a time in the background. For
   each finished clip, it calls back into **this repo's own** bridge
   route, `POST /emotion/result` (see `emotionApi.js`) — prediction,
   clip name, and the video's first frame (or, in `mif` mode, the
   annotated frame plus both full prompt texts as a follow-up message) —
   which is what actually posts the result to Discord. Alani-Bot is
   always the one that talks to Discord; Alani Emotion never does.
3. Once the whole batch is done, `POST /emotion/batch-done` posts a short
   summary (`N/M succeeded`).

A failed clip is left without any prefix (not `DONE_`, not anything
else), so the next `run1`/`runany` automatically retries it.

## Resend

`.a emo resend <all|recent|<filename>>` — re-posts already-computed
results straight from Alani Emotion's own records (its cached prediction
+ persisted first frame), with **no Drive listing, no preprocessing, and
no OpenRouter calls at all**. Exists for a real failure mode: a run can
finish successfully (clip renamed to `DONE_...`, prediction computed and
cached) while the final callback that actually delivers it to Discord
gets lost to a transient network blip between the two containers.
Recomputing the whole pipeline just to redeliver something that's already
sitting on disk would be wasteful — `resend` just re-reads and re-sends.

- `all` — every clip ever successfully processed
- `recent` — successful clips from the last 24 hours
- anything else is treated as a filename (matches either the name as it
  was when logged, or that name with `DONE_` prefixed, since Drive
  renames the file after success but the record keeps whatever name was
  current at the time)

If the original run used `mif`, resend replays that too (the full prompt
text was cached alongside everything else) — otherwise it just re-sends
the plain result, same as that run produced.

## Storage

All persistent state for this feature — the per-clip cached-modality
JSON, the OpenRouter responses, and the single CSV that doubles as both
"current status of every clip" (latest row per clip) and "history of
every call" (the full row history) — lives entirely on the Alani
Emotion service's own disk, not in this repo's SQLite. See that
service's own docs for the exact schema.
