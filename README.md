# Uni Admissions Discord Bot

Sends a daily formatted status update (🟢 open / 🟡 idle / 🔴 closed / ⚪ unknown)
for a tracked list of master's programs, via a Discord webhook and/or bot DM.

## How it works

- `data/programs.json` is the source of truth — one entry per program, with
  `status`, `openDate`, `closeDate`, `link`, `notes`. You (or Claude, in a
  follow-up session) edit this file whenever a program's status is confirmed
  from the official site.
- `npm start` reads `programs.json`, compares it against `data/state.json`
  (what was sent last time) to detect changes, then:
  - **Always** posts the full status list to the channel via the bot,
    tagging any changed/new entries with 🆕.
  - **Only if** a program's status actually changed since last run, also
    sends you a DM per changed program: `‼️*program name* Status changed`.
    No changes → no DM, so you're not pinged for nothing.
  - **Manual runs** (triggered by hand from the Actions tab, or `FORCE_DM=true`
    locally) always send a DM too, even with no changes — so you can confirm
    DM delivery on demand.
- Automated scraping of the 11 tracked pages isn't wired up yet — the sites
  are a mix of static pages, JS-rendered portals, and PDFs, so scraping needs
  to be built per-site. v1 is manual/config-driven so you never get a false
  🟢/🔴 signal on a real deadline.

## 1. Install dependencies

```bash
npm install
```

## 2. Add your token and IDs

Copy `.env.example` to `.env`:

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

All delivery goes through the bot now (no webhook) — you need all three of
these set.

## 3. Test delivery immediately

Before trusting the daily schedule, confirm sending actually works:

```bash
npm run test-send
```

This sends a short "✅ Test message" through every method you've configured.
Check your Discord channel/DMs for it.

## 4. Run a real update manually

```bash
npm start
```

This sends the full formatted status list and updates `data/state.json`.

## 5. Schedule it to run daily at 9:00 AM (Bangkok time)

A GitHub Actions workflow is already set up at
`.github/workflows/daily-update.yml`, scheduled for `0 2 * * *` UTC
(= 9:00 AM Indochina Time).

To activate it:

1. Push this project to a GitHub repo (can be private).
2. In the repo, go to **Settings → Secrets and variables → Actions** and add
   these repository secrets (same values as your `.env`):
   - `DISCORD_BOT_TOKEN`
   - `DISCORD_USER_ID`
   - `DISCORD_CHANNEL_ID`
3. That's it — GitHub will run the job daily and commit the updated
   `data/state.json` back to the repo so the "what changed" diff keeps
   working across runs.
4. You can trigger it manually anytime from the **Actions** tab
   ("Run workflow" button — `workflow_dispatch` is enabled).

If you'd rather not use GitHub Actions, any machine that stays on (or a
cheap VPS / Windows Task Scheduler / cron) can just run `npm start` once a
day instead.

## Updating program status

Edit `data/programs.json`. Each entry:

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

`status` must be one of: `"idle"`, `"open"`, `"closed"`, `"unknown"`.
Leave dates as `null` (or omit) if unconfirmed — the message will print
"unconfirmed" rather than a guess.

## Next steps / open items

- **Per-university scraping**: once we check which of the 11 program pages
  are static HTML vs. JS-rendered vs. PDF-only, we can add automated
  fetchers per site instead of hand-editing `programs.json`. Good next
  session for Claude Code.
- **Outbound network access**: confirmed via direct `fetch()` calls to
  `discord.com` — no gateway connection needed, so this works fine from
  GitHub Actions or any sandboxed runner with outbound HTTPS.
