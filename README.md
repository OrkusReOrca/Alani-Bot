# Alani Bot

A personal Discord bot with multiple independent features. Organized as
feature modules so new capabilities can be added without tangling into
existing ones.

## Structure

```
src/
  bot.js                         the persistent 24/7 bot process — only needed for
                                  interactive commands (slash + prefix both require
                                  a live gateway connection); everything else here
                                  runs as one-off scheduled scripts and doesn't
                                  need this running
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
  <feature-name>/                this feature's persisted state / source data —
                                  JSON state files are committed back to git by
                                  their workflow (see below); *.db SQLite files
                                  (e.g. orkus-info/) are NOT — they live only on
                                  the bot's own host storage, see .gitignore

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

A feature is either **scheduled** (a script, triggered by a GitHub Actions
workflow, doesn't need the bot running) or an **interactive command**
(slash and/or prefix — needs `src/bot.js` connected 24/7, since Discord
delivers interactions and messages over a live gateway connection, not
something you can trigger on a schedule).

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
- **[db](src/features/db/README.md)** — `.a db ...`, admin-level (owner-only,
  one dedicated channel) access to structured data — reminders and
  calendar events for now, via **[orkus-info](src/features/orkus-info/README.md)**,
  extensible to more databases later. SQLite-backed, with duplicate and
  overlap detection.

## Setup

```bash
npm install
cp .env.example .env   # fill in your bot token + IDs
```

See each feature's own README for what env vars it needs and how to run it.

## Persistent bot (slash + prefix commands)

Only needed for interactive commands (currently `info`, `fjamtrack shop`,
and `db`) — the scheduled features above don't need this running at all.

Every command is reachable as a **prefix command** — `.a <name> [args]`
(e.g. `.a info`, `.a fjamtrack shop`, `.a db list events`), typed as a
plain message in any channel Alani can see (`db` is the one exception —
restricted to a single channel and two users; see
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

## Adding a new feature

1. `src/features/<name>/` for its code.
2. `data/<name>/` if it needs persisted state.
3. Reuse `src/common/discordApi.js` for sending — extend it instead of
   duplicating REST calls if a new feature needs something it doesn't do yet.
4. Add `start:<name>` / `test-send:<name>` scripts to the root `package.json`.
5. Add a `.github/workflows/<name>-*.yml` if it needs to run on a schedule.
6. Write a `src/features/<name>/README.md` covering that feature's setup.

## A note on scheduled workflow timing

GitHub's `schedule` trigger is documented as best-effort, not exact — it
can be delayed under high platform load, and GitHub specifically calls out
round minutes (`:00`, `:05`, `:30`, the top of every hour) as the worst
case, since every other repo on the platform tends to schedule there too.
This was observed directly in this repo: crons set at `:00`/`:30` ran
45-90 minutes late. There's no paid tier that fixes this — it's a
platform-wide scheduling-service behavior, not a runner-capacity limit —
so every cron in this repo is deliberately set to an off-round minute
(e.g. `:19`, `:37`, `:12`) instead. If you add a new scheduled workflow,
follow the same pattern rather than round numbers.
