# Uni Application Updater

Sends a daily formatted status update (🟢 open / 🟡 idle / 🔴 closed / 🟣 error)
for a tracked list of master's programs, via the Alani Discord bot.

Part of the [Alani-Bot](../../../README.md) repo — see the root README for
overall repo structure if you're adding another feature alongside this one.

## Who this is for

`data/uni-application-updater/applicant-profile.json` holds the applicant's
background and target intake — Thai, Computer Engineering at MUIC (50%
scholarship, 3.70 GPA, IELTS 7.5), a JAIST research internship on VLM-based
emotion prediction, AI/ML grad school interest with a longer-term space
industry/robotics ambition, expected graduation ~April 2027, and a **target
intake of August 2027 (primary) / January 2028 (fallback)**.

That target intake matters for research accuracy: the relevant application
round for each program is the one leading to an Aug 2027 or Jan 2028 start —
not whichever round most recently closed. The scheduled research routine
(see below) is briefed with this file's contents so it looks for the right
cycle instead of reporting on a stale/irrelevant one.

## How it works

- `data/uni-application-updater/programs.json` is the source of truth — one
  entry per program, with `status`, `openDate`, `closeDate`, `link`, `notes`.
  A scheduled cloud routine (`uni-admissions-status-refresh`, runs daily at
  8:30 AM Bangkok time, 30 min before the Discord post) researches each
  program against official sources and updates this file. You can also edit
  it by hand any time.
- `npm run start:uni-application-updater` reads `programs.json`, compares it
  against `data/uni-application-updater/state.json` (what was sent last
  time) to detect changes, then:
  - **Always** posts the full status list to the channel via the bot,
    tagging any changed/new entries with 🆕.
  - **Only if** a program's status actually changed since last run, also
    sends you a DM per changed program: `‼️*program name* Status changed`.
    No changes → no DM, so you're not pinged for nothing.
  - **Manual runs** (triggered by hand from the Actions tab, or `FORCE_DM=true`
    locally) always send a DM too, even with no changes — so you can confirm
    DM delivery on demand.
- The research routine never guesses — many of the tracked pages are
  JS-rendered portals or sit behind an egress-restricted sandbox, so status
  frequently comes back `error` rather than a confident open/closed. That's
  intentional: a false 🟢/🔴 on a real deadline is worse than an honest
  "couldn't confirm, here's the closest link."

## 1. Install dependencies

From the repo root:

```bash
npm install
```

## 2. Add your token and IDs

Copy `.env.example` (repo root) to `.env` (repo root):

```bash
cp .env.example .env
```

Then open `.env` and fill in:

| Variable | Where to get it |
|---|---|
| `DISCORD_BOT_TOKEN` | Discord Developer Portal → your application → Bot → Reset/Copy Token |
| `DISCORD_USER_ID` | Enable Developer Mode (Discord Settings → Advanced), right-click your name → Copy User ID |
| `DISCORD_CHANNEL_ID` | Right-click the target channel → Copy Channel ID. The bot needs to be a member of the server with permission to post there. |

`.env` is already in `.gitignore` — it will never be committed.

This feature delivers everything through the bot (no webhook) — you need
all three of these set.

## 3. Test delivery immediately

Before trusting the daily schedule, confirm sending actually works:

```bash
npm run test-send:uni-application-updater
```

This sends a short "✅ Test message" through every method you've configured.
Check your Discord channel/DMs for it.

## 4. Run a real update manually

```bash
npm run start:uni-application-updater
```

This sends the full formatted status list and updates
`data/uni-application-updater/state.json`.

## 5. Schedule it to run daily at 9:00 AM (Bangkok time)

A GitHub Actions workflow is already set up at
`.github/workflows/uni-application-updater-daily.yml`, scheduled for
`0 2 * * *` UTC (= 9:00 AM Indochina Time).

To activate it:

1. In the repo, go to **Settings → Secrets and variables → Actions** and add
   these repository secrets (same values as your `.env`):
   - `DISCORD_BOT_TOKEN`
   - `DISCORD_USER_ID`
   - `DISCORD_CHANNEL_ID`
2. That's it — GitHub will run the job daily and commit the updated
   `state.json` back to the repo so the "what changed" diff keeps working
   across runs.
3. You can trigger it manually anytime from the **Actions** tab
   ("Run workflow" button — `workflow_dispatch` is enabled).

If you'd rather not use GitHub Actions, any machine that stays on (or a
cheap VPS / Windows Task Scheduler / cron) can just run
`npm run start:uni-application-updater` once a day instead.

## Updating program status

Edit `data/uni-application-updater/programs.json`. Each entry:

```json
{
  "id": "tsinghua-sigs-dst",
  "university": "Tsinghua SIGS",
  "program": "Data Science and Technology (English-taught Program)",
  "priority": 1,
  "status": "open",
  "openDate": "2026-09-01",
  "closeDate": "2026-11-15",
  "link": "https://sigs.tsinghua.edu.cn/...",
  "notes": ""
}
```

`status` must be one of:
- `"idle"` 🟡 — not yet open; `openDate` is the expected open date.
- `"open"` 🟢 — accepting applications now; `closeDate` + `link` should be set.
- `"closed"` 🔴 — past the deadline; `openDate` is the expected next open date.
- `"error"` 🟣 — status couldn't be confirmed (page unreachable, unclear, or
  conflicting signals). `link` should still point to the closest official
  page you found, so a human can check by hand — this is required, not
  optional, when status is `"error"`.

Leave dates as `null` (or omit) if unconfirmed — the message will print
"unconfirmed" rather than a guess. Never guess a status — an honest `"error"`
with a link beats a wrong `"open"`/`"closed"` on a real deadline.

## The research routine

`uni-admissions-status-refresh` is a scheduled cloud routine (not part of
this repo's code — managed at https://claude.ai/code/routines) that runs
daily before the Discord post. It reads `applicant-profile.json` and
`programs.json`, researches each program against official sources, and
pushes an updated `programs.json`. It frequently lands on `"error"` for
programs whose official domain is unreachable from its sandboxed network or
whose current-cycle dates aren't published — that's expected, not a bug.
