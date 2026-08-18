# Fortnite Jam Tracks Updater

Tracks the Jam Tracks section of the Fortnite item shop and posts to a
Discord channel when tracks are added or leave.

Part of the [Alani-Bot](../../../README.md) repo.

## How it works

Runs as two separate steps, 30 minutes apart:

1. **Check** (7:30 AM Bangkok time) — fetches the current shop from
   [fortnite-api.com](https://fortnite-api.com) (a public, key-free API
   that mirrors the real in-game shop), diffs it against yesterday's saved
   snapshot, and saves the diff + new snapshot.
2. **Post** (8:00 AM Bangkok time) — reads that diff and posts to Discord,
   in this order:
   - **The grid image** — every track currently in the shop as a
     poster-thumbnail-and-name grid, sorted newest-to-oldest by shop add
     date, black background, each cell showing the track name plus days
     left in the shop, and tracks added today outlined in green. This is
     the "what's new" announcement — there's no separate per-track message.
     Drawn server-side with the `canvas` library (`generateGridImage.js`)
     — no LLM call involved, same as every other part of this feature.
   - **One combined message** listing the names of every track that left
     since yesterday (name only) — skipped entirely if nothing left.
   - The grid always sends regardless of whether anything changed (it
     reflects today's full shop either way); the left-tracks message only
     sends when there's something to report.

The two steps are split (rather than one script doing both at 8:00) to
mirror the pattern used for other scheduled features in this repo and give
a buffer window — see `.github/workflows/fortnite-jam-tracks-check.yml`
and `fortnite-jam-tracks-post.yml`.

### Why fortnite-api.com instead of fortnite.gg directly

The user-requested source, `fortnite.gg/shop?filter=jamtracks`, is
Cloudflare-protected (bot-challenge scripts load on every request) — a
plain HTTP fetch from a CI runner gets a 403, and building around that
challenge deliberately isn't something this bot does. fortnite-api.com is
a public, well-known third-party API mirroring the same official shop data
with no auth required, and its `tracks` field on each shop entry is what's
used to identify Jam Track items specifically (an entry's `layout.name`
is NOT reliably "Jam Tracks" — artist-specific bundles use their own
layout name — so the code filters on the presence of `tracks` instead).

## Setup

Same `.env` file as other features (repo root). Add one new variable:

| Variable | Where to get it |
|---|---|
| `DISCORD_FORTNITE_CHANNEL_ID` | Right-click the target channel in the friend server → Copy Channel ID. The bot must already be a member with permission to post there. |

`DISCORD_BOT_TOKEN` is shared with the other feature — same bot (Alani),
same token, different channel.

The grid image uses the `canvas` npm package, which is a native module —
`fortnite-jam-tracks-post.yml` installs its system libraries
(`libcairo2-dev` etc.) via `apt-get` before `npm install`. Running `post`
locally on a non-Debian machine may need the equivalent packages for your
OS (see [node-canvas's install docs](https://github.com/Automattic/node-canvas#compiling)).

## Test delivery

```bash
npm run test-send:fortnite-jam-tracks-updater
```

## Run manually

```bash
npm run check:fortnite-jam-tracks-updater
npm run post:fortnite-jam-tracks-updater
```

Running `check` twice in a row without `post` in between is safe — each
`check` overwrites the pending diff with a fresh one.

`post` always does both the grid image and the left-tracks message — that
part of the daily flow is unchanged. To send **just the grid image** on its
own, without touching the new/left diff at all:

```bash
npm run post-grid:fortnite-jam-tracks-updater
```

This re-renders the grid from whatever's currently in `state.json` (today's
shop) and sends it standalone — useful for re-sending after a bad
render, or just wanting an on-demand snapshot. It reuses whichever
`newTracks` are currently sitting in the pending diff for the green
border, so if the daily `post` already ran (and cleared the diff), a
manual re-trigger afterward just won't highlight anything — that's
correct, since today's new/left status was already reported once.

## Schedule

Three workflows, all triggerable manually from the Actions tab
(`workflow_dispatch`) in addition to their schedule:

- `fortnite-jam-tracks-check.yml` — 7:30 AM Bangkok, cron.
- `fortnite-jam-tracks-post.yml` — 8:00 AM Bangkok, cron. Runs the full
  daily flow (grid image + left-tracks message).
- `fortnite-jam-tracks-grid.yml` — **manual only**, no cron. Runs just
  `post-grid` above, for triggering the grid image by itself.

Add `DISCORD_FORTNITE_CHANNEL_ID` as a repo secret alongside the existing
`DISCORD_BOT_TOKEN` to activate all three.

## First run

The very first `check` run has no prior snapshot, so every track currently
in the shop counts as "new" and shows outlined in green on the grid —
that's intentional, so the first grid doubles as a full listing of what's
available right now, with everything highlighted.
