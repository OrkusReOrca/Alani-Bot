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

## 5. Daily schedule (~9:19 AM Bangkok time)

Runs in-process on the persistent bot's daily timer —
`src/common/dailyJobs.js`, started from `bot.js`'s `ClientReady` handler —
as long as `npm start` is running with `DISCORD_BOT_TOKEN`,
`DISCORD_USER_ID`, and `DISCORD_CHANNEL_ID` set in its `.env`. No
GitHub Actions setup needed for this to run daily; see the root README's
"Daily jobs" section for how the in-process timer works.

`.github/workflows/uni-application-updater-daily.yml` still exists but is
**deactivated** (its `schedule:` trigger is commented out) — kept as a
manual fallback via the **Actions** tab's "Run workflow" button
(`workflow_dispatch`), which still needs `DISCORD_BOT_TOKEN`,
`DISCORD_USER_ID`, `DISCORD_CHANNEL_ID` set as repository secrets
(**Settings → Secrets and variables → Actions**) to work. A manual run
that way sends a DM even with no status changes (`FORCE_DM=true`, set
automatically for `workflow_dispatch`), and writes `state.json` back into
the repo via git commit — the in-process daily job writes straight to the
bot host's own disk instead, no git commit involved.

If you'd rather not run the persistent bot at all, any machine that stays
on (a cheap VPS, Windows Task Scheduler, plain `cron`) can still just run
`npm run start:uni-application-updater` once a day.

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
  "bestGuess": null,
  "notes": ""
}
```

`status` must be one of:
- `"idle"` 🟡 — not yet open; `openDate` is the expected open date.
- `"open"` 🟢 — accepting applications now; `closeDate` + `link` should be set.
- `"closed"` 🔴 — past the deadline; `openDate` is the expected next open date.
- `"error"` 🟣 — status couldn't be officially confirmed (page unreachable,
  unclear, or conflicting signals). `link` is required (not optional) —
  point it at the closest official page found, so a human can check by hand.
  `bestGuess` is optional: a short plain-English "most likely" read on the
  situation from secondary sources (news, social media, cached copies),
  clearly speculative — it does NOT upgrade the status to open/closed, it's
  shown alongside the `error` status as a hint, never as a confirmed fact.

Leave dates as `null` (or omit) if unconfirmed — the message will print
"unconfirmed" rather than a guess. Never guess a *status* — an honest
`"error"` with a link (and optionally a caveated `bestGuess`) beats a wrong
`"open"`/`"closed"` on a real deadline.

### Sourcing priority

1. **Official university/department page — most trustworthy, always checked first.**
   For Tsinghua SIGS specifically, these are the canonical pages:
   - Data Science and Technology: https://www.sigs.tsinghua.edu.cn/en/2024/1230/c7587a99293/page.htm
   - Internet+ Innovation Design (AI+X): https://www.sigs.tsinghua.edu.cn/en/2024/1230/c7587a99311/page.htm
2. When the official page can't be confirmed (unreachable, no current-cycle
   info, or ambiguous), the routine also checks **news sources and social
   media** (official program/department social accounts, university news
   posts) for secondary signal — this can populate `bestGuess` but never
   upgrades `status` away from `"error"`.

## The research routine

`uni-admissions-status-refresh` is a scheduled cloud routine (not part of
this repo's code — managed at https://claude.ai/code/routines) that runs
daily before the Discord post. It reads `applicant-profile.json` and
`programs.json`, researches each program against official sources, and
pushes an updated `programs.json`. It frequently lands on `"error"` for
programs whose official domain is unreachable from its sandboxed network or
whose current-cycle dates aren't published — that's expected, not a bug.
