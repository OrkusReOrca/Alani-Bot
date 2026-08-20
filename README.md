# Alani Bot

A personal Discord bot with multiple independent features. Organized as
feature modules so new capabilities can be added without tangling into
existing ones.

## Structure

```
src/
  bot.js                         the persistent 24/7 bot process — only needed for
                                  slash commands (interactions require a live gateway
                                  connection); everything else here runs as one-off
                                  scheduled scripts and doesn't need this running
  deployCommands.js              registers slash commands with Discord — run once,
                                  and again whenever a command's shape changes
  common/                       shared plumbing used by every feature
    discordApi.js               thin REST wrapper: DM, channel posts, embeds, file
                                 attachments via bot token, with 429 retry handling
    config.js                   bot-level env vars (token, client ID) — for
                                 bot.js/deployCommands.js, as opposed to each
                                 feature's own config.js
  features/
    <feature-name>/             one folder per independent capability
      config.js                 env vars this feature needs
      README.md                 feature-specific setup & usage docs
      command.js                (slash-command features only) `data` + `execute`,
                                 registered in bot.js's command map
      ...                       the rest of its code

data/
  <feature-name>/                this feature's persisted state / source data

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
workflow, doesn't need the bot running) or a **slash command** (needs
`src/bot.js` connected 24/7, since Discord delivers interactions over a
live gateway connection, not a webhook you can trigger on a schedule).

## Features

- **[uni-application-updater](src/features/uni-application-updater/README.md)**
  — daily channel post + change-alert DMs tracking master's program
  admission status across Tsinghua/NTU/NUS.
- **[fortnite-jam-tracks-tracker](src/features/fortnite-jam-tracks-tracker/README.md)**
  — daily channel posts (friend server) tracking Fortnite's Jam Tracks:
  - **[shop](src/features/fortnite-jam-tracks-tracker/shop/README.md)** —
    grid image of every Jam Track currently in the purchasable item shop
    (new ones outlined in green), plus a message for tracks that left.
- **[info](src/features/info/README.md)** — `/info` (or `.a info`), a brief
  self-introduction plus the current list of commands and features.

## Setup

```bash
npm install
cp .env.example .env   # fill in your bot token + IDs
```

See each feature's own README for what env vars it needs and how to run it.

## Persistent bot (slash + prefix commands)

Only needed for interactive features (currently just `info`) — the
scheduled features above don't need this running at all.

Every command works two ways, both handled by the same running process:
- **Slash command** — `/info`, needs registering once (see below).
- **Prefix command** — `.a info`, typed as a plain message in any channel
  Alani can see. No registration needed, but Discord requires explicitly
  turning on the **Message Content** privileged intent for this bot
  (Discord Developer Portal -> your application -> Bot tab -> "Message
  Content Intent") — without it, `.a info` is silently ignored (the bot
  isn't allowed to read message text at all otherwise).

```bash
npm run deploy-commands   # once, and again whenever a command's shape changes
npm start                 # runs src/bot.js — needs to stay running 24/7
```

Needs `DISCORD_BOT_TOKEN` (both) and `DISCORD_CLIENT_ID` (deploy-commands
only) in `.env`. For 24/7 hosting: point the host at this repo, set those
two as environment variables in its dashboard, and set the start command to
`npm start` (or `node src/bot.js`) — `npm install` runs automatically on
most hosts, but `deploy-commands` does not, since it only needs to run once
per command change, not on every boot/deploy.

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
