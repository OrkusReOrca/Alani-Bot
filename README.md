# Alani Bot

A personal Discord bot with multiple independent features. Organized as
feature modules so new capabilities can be added without tangling into
existing ones.

## Structure

```
src/
  bot.js                         the persistent 24/7 bot process — needed for
                                  interactive commands (slash + prefix both require
                                  a live gateway connection) AND for whichever daily
                                  jobs run in-process (see common/dailyJobs.js) —
                                  not every feature's daily job qualifies; some still
                                  need GitHub Actions specifically (e.g. one needing
                                  a native module bot-hosting.net's script policy
                                  blocks), see "Daily jobs" in this README
  deployCommands.js              registers slash commands with Discord — run once,
                                  and again whenever a command's shape changes
  common/                       shared plumbing used by every feature
    discordApi.js               thin REST wrapper: DM, channel posts, embeds, file
                                 attachments via bot token, with 429 retry handling
    config.js                   bot-level env vars (token, client ID) — for
                                 bot.js/deployCommands.js, as opposed to each
                                 feature's own config.js
    auth.js                     owner allowlist for admin features (currently just
                                 db) — who's allowed, as opposed to config.js's
                                 where-to-connect concerns
  features/
    <feature-name>/             one folder per independent capability
      config.js                 env vars this feature needs
      README.md                 feature-specific setup & usage docs
      command.js                (interactive features only) `data` + `execute(ctx,
                                 args)`, registered in bot.js's command map. Always
                                 reachable as a prefix command (.a <name>); also a
                                 slash command (/name) if `data` has a `description`
                                 — see bot.js's own header comment.
      ...                       the rest of its code

data/
  <feature-name>/                this feature's persisted state / source data.
                                  JSON state files are committed back to git by their
                                  workflow on every scheduled run — UNLESS that job
                                  now runs in-process (see "Daily jobs" below), in
                                  which case it's written straight to the host's own
                                  disk instead, same as *.db SQLite files (e.g.
                                  orkus-info/) always have been — see .gitignore.

.github/workflows/
  <feature-name>-*.yml           this feature's scheduled trigger(s)
```

Each feature gets its own subfolder under `src/features/`, its own `data/`
subfolder if it needs persisted state, its own npm scripts
(`start:<feature>`, `test-send:<feature>`, etc.), and its own workflow file
if it runs on a schedule. Code that's genuinely shared across features
(Discord send/receive helpers, auth, logging) lives in `src/common/`.

Closely related capabilities that post to the same place can be grouped
under one parent feature folder with sub-feature subfolders (e.g.
`fortnite-jam-tracks-tracker/shop/`) instead of being separate top-level
features — same rules apply one level deeper: each sub-feature still gets
its own `data/` subfolder, npm scripts, and workflow file.

A feature is either a **daily job** — a `run()` function, either
triggered in-process by `src/common/dailyJobs.js` on a timer, or still a
standalone script triggered by a GitHub Actions workflow (when the bot
host can't run it itself — see "Daily jobs" below for why that's not
always a free choice) — or an **interactive command** (slash and/or
prefix — needs `src/bot.js` connected 24/7, since Discord delivers
interactions and messages over a live gateway connection, not something
you can trigger on a schedule).

## Features

- **[uni-application-updater](src/features/uni-application-updater/README.md)**
  — daily channel post + change-alert DMs tracking master's program
  admission status across Tsinghua/NTU/NUS.
- **[fortnite-jam-tracks-tracker](src/features/fortnite-jam-tracks-tracker/README.md)**
  — daily channel posts (friend server) tracking Fortnite's Jam Tracks:
  - **[shop](src/features/fortnite-jam-tracks-tracker/shop/README.md)** —
    grid image of every Jam Track currently in the purchasable item shop
    (new ones outlined in green), plus a message for tracks that left. Also
    available on demand via `.a fjamtrack shop`.
- **[info](src/features/info/README.md)** — `/info` (or `.a info`), a brief
  self-introduction plus the current list of commands and features.
- **[db](src/features/db/README.md)** — `.a db ...`, structured data
  (reminders, calendar events) across a tiered permission system: a fixed
  owner-only Main database (**[orkus-info](src/features/orkus-info/README.md)**,
  synced to Google Calendar) plus Tier Personal/Tier Server, which let
  owner-granted regular users create and manage their own private or
  guild-scoped database. See "Tiers" below. SQLite-backed throughout, with
  duplicate and overlap detection.

## Tiers

`.a db`'s permission model is per-database, not one flat gate. Full
detail (exact commands, resolution rules, frozen/revoke semantics) is in
[src/features/db/README.md](src/features/db/README.md) — summary:

| Tier | Who | Database | Access | Google Calendar | Discord Scheduled Event |
|---|---|---|---|---|---|
| **Main** | fixed — `DISCORD_OWNER_0`/`DISCORD_OWNER_1` only | orkus-info (the original, single database) | command-box channel only | yes | no |
| **Personal** | any user an owner grants it to | one private "general-user-db" per user | any channel, owner only | no | no |
| **Server** | any user an owner grants it to | one "general-server-db" per user, scoped to one guild; owner can add collaborators | any channel, owner + collaborators | no | yes — events also create/edit/delete a real Discord server event |

Bot owners can always reach every database, every tier, everywhere —
including ones another user's revoked tier has "frozen" (fully
inaccessible to anyone else until re-granted or `.a db transfer`red).

## Setup

```bash
npm install
cp .env.example .env   # fill in your bot token + IDs
```

See each feature's own README for what env vars it needs and how to run it.

## Persistent bot (slash + prefix commands, and some daily jobs)

Needed for interactive commands (currently `info`, `fjamtrack shop`, and
`db`) and for whichever daily jobs run in-process — see "Daily jobs"
below for which ones that currently is, and why not all of them qualify.

Every command is reachable as a **prefix command** — `.a <name> [args]`
(e.g. `.a info`, `.a fjamtrack shop`, `.a db list events`), typed as a
plain message in any channel Alani can see (`db`'s Main tier is the one
exception — restricted to a single channel and two owners; every other
tier works in any channel — see "Tiers" below and
[src/features/db/README.md](src/features/db/README.md)). No registration
needed, but Discord requires explicitly turning on the **Message Content**
privileged intent for this bot (Discord Developer Portal -> your
application -> Bot tab -> "Message Content Intent") — without it, prefix
commands are silently ignored (the bot isn't allowed to read message text
at all otherwise).

Some commands (currently just `info`) are also **slash commands** —
`/info` — which need registering once (see below). Slash commands need a
single-word name and structured options, so a command like
`fjamtrack shop` (a name plus a freeform subcommand) stays prefix-only.

```bash
npm run deploy-commands   # once, and again whenever a command's shape changes
npm start                 # runs src/bot.js — needs to stay running 24/7
```

Needs `DISCORD_BOT_TOKEN` (both) and `DISCORD_CLIENT_ID` (deploy-commands
only) in `.env`. `db` additionally needs `DISCORD_COMMAND_BOX`,
`DISCORD_OWNER_0`, and `DISCORD_OWNER_1` — see
[src/features/db/README.md](src/features/db/README.md). For 24/7 hosting:
point the host at this repo, set those as environment variables in its
dashboard, and set the start command to `npm start` (or `node src/bot.js`)
— `npm install` runs automatically on most hosts, but `deploy-commands`
does not, since it only needs to run once per command change, not on
every boot/deploy.

## Voice bridge

Lets voice-Alani (a separate app, running locally on the user's PC — not
this repo) trigger things here by voice — reminders for now, via
`src/features/db/voiceApi.js`, a small authenticated HTTP endpoint the
persistent bot also starts. Not routed through Discord itself: this bot's
own `messageCreate` handler ignores messages from any bot account, so
voice-Alani posting as a bot or webhook would never reach `.a db`'s
command parser (or pass its owner check, which needs a real user ID) —
an HTTP endpoint is the actually-correct way to bridge two independent
services, not a workaround.

Deliberately Main-tier only — voice-Alani reaches orkus-info exclusively,
not any Tier Personal/Server database (see "Tiers" above). There's no
product reason for voice to reach anyone's personal or server database,
and it has no concept of Discord users' own tiers to begin with.

**Setup:**
1. Generate any long random string for `VOICE_API_SECRET` — set it as an
   environment variable here (same dashboard as the other secrets), and
   put the identical value in voice-Alani's own `.env` as
   `ALANI_BOT_API_SECRET`.
2. On the host, find the port + IP this deployment is reachable on
   (bot-hosting.net: the deployment's **Network** tab — it assigns a
   static IP with no NAT/proxy in front, and the port matches
   `SERVER_PORT`, which `voiceApi.js` listens on automatically — no
   separate port to open). Put `http://<that-ip>:<that-port>` in
   voice-Alani's `.env` as `ALANI_BOT_API_URL`.
3. Restart both. `VOICE_API_SECRET` unset on this side disables the
   bridge entirely (rest of the bot runs fine either way) — check the
   console for `[voiceApi] listening on port ...` to confirm it's up.

**Endpoints** (all header `Authorization: Bearer <VOICE_API_SECRET>`,
24hr Indochina/Bangkok time throughout, same convention `.a db` uses):

- `POST /voice/reminder` `{"text", "remindAt"}` -> add. Always DMs
  `DISCORD_OWNER_0` (never a channel — voice reminders don't take one)
  and announces the add in the command-box channel, e.g. `Added
  reminder "take out trash" at 15:00 2026/08/20 by voice.`
- `GET /voice/reminders` -> list.
- `POST /voice/reminder/delete` `{"id"}` -> delete.
- `POST /voice/event` `{"title", "start", "end"?, "allDay"?}` -> add
  (also syncs to Google Calendar, same as the chat command). `end`
  omitted defaults to a 1-hour event; `allDay: true` makes it an all-day
  event instead (`end` ignored). `start`/`end` also accept partial dates
  (year and/or month omitted, assumed current), same as the chat command.
- `GET /voice/events` -> list.
- `POST /voice/event/delete` `{"id"}` -> delete.

All of these reuse the exact same underlying logic the `.a db` chat
command goes through — see
[src/features/orkus-info/README.md](src/features/orkus-info/README.md)
for the shared behavior (dedup, delivery, Google Calendar sync, etc.).

**Security note:** bot-hosting.net's exposed port has no TLS termination
(no reverse proxy in front, per their own docs), so this secret travels
in cleartext over the public internet on every call. Acceptable for a
personal hobby bridge; if that's ever a real concern, put a domain + TLS
in front (their "Domains" feature) rather than trusting this bare.

## Adding a new feature

1. `src/features/<name>/` for its code.
2. `data/<name>/` if it needs persisted state.
3. Reuse `src/common/discordApi.js` for sending — extend it instead of
   duplicating REST calls if a new feature needs something it doesn't do yet.
4. Add `start:<name>` / `test-send:<name>` scripts to the root `package.json`.
5. Add a `.github/workflows/<name>-*.yml` if it needs to run on a schedule.
6. Write a `src/features/<name>/README.md` covering that feature's setup.

## Daily jobs

`uni-application-updater`'s daily update runs in-process, on a 30s-poll
timer in `src/common/dailyJobs.js` (started from `bot.js`'s
`ClientReady` handler, same as `orkus-info`'s reminder scheduler) —
moved off GitHub Actions cron once the bot itself became a 24/7 process
on bot-hosting.net, since there's no reason to wait on GitHub's Actions
queue (see the note on timing below) for something the always-on bot can
just do itself, dead on time, every day.

The job is still a plain exported `run()` function in its usual file
(`run.js`) — `dailyJobs.js` just imports and calls it directly instead of
it being invoked as a separate `node` process. That file still has its
own CLI entry point too (guarded so it only fires when the file is
actually run as a script, not when `dailyJobs.js` imports it), so
`npm run start:uni-application-updater` still works exactly as before.

**`fortnite-jam-tracks-tracker`'s shop check/post is NOT here** — it was
tried the same way and reverted. `postRun.js` needs the `canvas` native
module to draw the grid image, and bot-hosting.net's script policy
blocks native-module builds (the exact same constraint `.a fjamtrack
shop`'s command already works around by never regenerating the grid
live on this host — see that command's own comment). GitHub Actions'
runners build `canvas` fine (an `apt-get` step installs its system libs
first), so that job stays on its original `.github/workflows/*.yml`
schedule, unchanged.

## A note on scheduled workflow timing

GitHub's `schedule` trigger is documented as best-effort, not exact — it
can be delayed under high platform load, and GitHub specifically calls out
round minutes (`:00`, `:05`, `:30`, the top of every hour) as the worst
case, since every other repo on the platform tends to schedule there too.
This was observed directly in this repo: crons set at `:00`/`:30` ran
45-90 minutes late. There's no paid tier that fixes this — it's a
platform-wide scheduling-service behavior, not a runner-capacity limit.
This is exactly the lateness `uni-application-updater`'s move to
`dailyJobs.js` sidesteps (its `:19` time lives on there, kept identical
so the daily post still lands when users are used to, even though
there's no GitHub queue left to dodge for that one). `fortnite-jam-
tracks-tracker`'s shop check/post is still on real GitHub Actions cron
(`:37`/`:12`) — it's stuck with this lateness risk until/unless `canvas`
becomes buildable on the bot host some other way. If you ever add a new
GitHub-Actions-scheduled workflow, follow the same off-round-minute
pattern regardless.
