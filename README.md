# Alani Bot

A personal Discord bot with multiple independent features. Organized as
feature modules so new capabilities can be added without tangling into
existing ones.

## Structure

```
src/
  common/                       shared plumbing used by every feature
    discordApi.js               thin REST wrapper: DM, channel posts, embeds, file
                                 attachments via bot token, with 429 retry handling
  features/
    <feature-name>/             one folder per independent capability
      config.js                 env vars this feature needs
      README.md                 feature-specific setup & usage docs
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
`fortnite-jam-tracks-tracker/{shop,in-play}/`) instead of being separate
top-level features — same rules apply one level deeper: each sub-feature
still gets its own `data/` subfolder, npm scripts, and workflow file.

## Features

- **[uni-application-updater](src/features/uni-application-updater/README.md)**
  — daily channel post + change-alert DMs tracking master's program
  admission status across Tsinghua/NTU/NUS.
- **[fortnite-jam-tracks-tracker](src/features/fortnite-jam-tracks-tracker/README.md)**
  — daily channel posts (friend server) tracking Fortnite's Jam Tracks,
  two sub-features:
  - **[shop](src/features/fortnite-jam-tracks-tracker/shop/README.md)** —
    grid image of every Jam Track currently in the purchasable item shop
    (new ones outlined in green), plus a message for tracks that left.
  - **[in-play](src/features/fortnite-jam-tracks-tracker/in-play/README.md)**
    — grid image of every Jam Track currently free to play, posted right
    after `shop`.

## Setup

```bash
npm install
cp .env.example .env   # fill in your bot token + IDs
```

See each feature's own README for what env vars it needs and how to run it.

## Adding a new feature

1. `src/features/<name>/` for its code.
2. `data/<name>/` if it needs persisted state.
3. Reuse `src/common/discordApi.js` for sending — extend it instead of
   duplicating REST calls if a new feature needs something it doesn't do yet.
4. Add `start:<name>` / `test-send:<name>` scripts to the root `package.json`.
5. Add a `.github/workflows/<name>-*.yml` if it needs to run on a schedule.
6. Write a `src/features/<name>/README.md` covering that feature's setup.
