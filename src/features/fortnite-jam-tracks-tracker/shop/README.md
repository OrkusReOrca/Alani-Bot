# Shop (Fortnite Jam Tracks Tracker)

Tracks the Jam Tracks section of the Fortnite item shop and posts to a
Discord channel when tracks are added or leave.

Sub-feature of [fortnite-jam-tracks-tracker](../README.md). Part of the
[Alani-Bot](../../../../README.md) repo.

## How it works

Runs as two separate steps, ~30 minutes apart:

1. **Check** (~7:37 AM Bangkok time) — fetches the current shop from
   [fortnite-api.com](https://fortnite-api.com) (a public, key-free API
   that mirrors the real in-game shop), diffs it against yesterday's saved
   snapshot, and saves the diff + new snapshot.
2. **Post** (~8:12 AM Bangkok time) — reads that diff and posts to Discord,
   in this order:
   - **The grid image** — every track currently in the shop as a
     poster-thumbnail-and-name grid, sorted newest-to-oldest by shop add
     date, black background, each cell showing the track name plus days
     left in the shop, and tracks added today outlined in green. Drawn
     server-side with the `canvas` library (`generateGridImage.js`) — no
     LLM call involved, same as every other part of this feature.
   - **One combined text message** — a compact list, one line per change:
     ```
     🟢+ *Track Name* -- *Artist Name* -- out date: *2d 14h*
     🟢+ *Another Track* -- *Another Artist* -- out date: *5d 3h*
     🔴+ *Track That Left*
     ```
     🟢 lines are new/rerun tracks (with artist and days left before they
     leave again); 🔴 lines are tracks that left since yesterday (name
     only — no artist/time info, there's nothing left to count down).
     Skipped entirely if nothing changed. Split into multiple messages
     only if it exceeds Discord's 2000-char limit (handled automatically
     by the shared sender — see `src/common/discordApi.js`'s
     `chunkMessage`).
   - The grid always sends regardless of whether anything changed (it
     reflects today's full shop either way); the text message only sends
     when there's something to report.

The two steps are split (rather than one script doing both) to give a
buffer window — still real GitHub Actions runs, each on its own
`.github/workflows/*.yml` cron. (A brief attempt moved both in-process on
the persistent bot; reverted because `post` needs the `canvas` native
module, which bot-hosting.net's script policy blocks from building — see
the root README's "Daily jobs" section.) Both times are deliberately off
round minutes — see the root README's note on scheduled workflow timing
for why.

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

Same `.env` file as other features (repo root):

| Variable | Where to get it |
|---|---|
| `DISCORD_FORTNITE_CHANNEL_ID` | Right-click the target channel in the friend server → Copy Channel ID. The bot must already be a member with permission to post there. |

`DISCORD_BOT_TOKEN` is shared with every feature in this repo.

The grid image uses the `canvas` npm package, which is a native module —
`fortnite-jam-tracks-tracker-shop-post.yml` installs its system libraries
(`libcairo2-dev` etc.) via `apt-get` before `npm install`. Running `post`
locally on a non-Debian machine may need the equivalent packages for your
OS (see [node-canvas's install docs](https://github.com/Automattic/node-canvas#compiling)).

## Test delivery

```bash
npm run test-send:fortnite-jam-tracks-tracker-shop
```

## Run manually

```bash
npm run check:fortnite-jam-tracks-tracker-shop
npm run post:fortnite-jam-tracks-tracker-shop
```

Running `check` twice in a row without `post` in between is safe — each
`check` overwrites the pending diff with a fresh one.

`post` always does both the grid image and the update text message — that
part of the daily flow is unchanged. To send **just the grid image** on its
own, without touching the new/left diff at all:

```bash
npm run post-grid:fortnite-jam-tracks-tracker-shop
```

This re-renders the grid from whatever's currently in `state.json` (today's
shop) and sends it standalone — useful for re-sending after a bad
render, or just wanting an on-demand snapshot. It reuses whichever
`newTracks` are currently sitting in the pending diff for the green
border, so if the daily `post` already ran (and cleared the diff), a
manual re-trigger afterward just won't highlight anything — that's
correct, since today's new/left status was already reported once.

## On-demand: `.a fjamtrack shop`

Replies with the most recently posted grid image in whichever channel you
typed it in — from local state (`data/fortnite-jam-tracks-tracker/shop/last-grid.json`,
written by `postShopGridImage()` right after each scheduled post, committed
back to the repo the same way `state.json` is). Handled by the persistent
bot process (`command.js`, see the root README's "Persistent bot"
section), not a script — needs the bot running, but
**not** `DISCORD_FORTNITE_CHANNEL_ID` or any Discord API lookup of its
own; it just reads that file.

Deliberately does NOT regenerate the grid live like `npm run post-grid`
does — that needs `canvas`, a native module some hosts won't let build
(bot-hosting.net's default script policy blocks it, which crashed the
whole bot the first time this command tried to run it). Since the grid
only actually changes once a day when the shop rotates, relaying whatever
the scheduled workflow posted most recently is equivalent in practice, and
sidesteps needing `canvas` on the bot's host entirely.

First use after adding this feature will say "No grid image has been
posted yet" until the next scheduled post (or a manual `workflow_dispatch`
of `fortnite-jam-tracks-tracker-shop-grid.yml` or `-post.yml`) actually
runs and commits `last-grid.json` for the first time.

## Schedule

Three workflows, all triggerable manually from the Actions tab
(`workflow_dispatch`) in addition to their schedule — see the root
README's "Daily jobs" section for why these run here and not in-process
on the bot like some other daily jobs in this repo (short version:
`post` needs the `canvas` native module, which bot-hosting.net's script
policy blocks from building):

- `fortnite-jam-tracks-tracker-shop-check.yml` — ~7:37 AM Bangkok, cron.
- `fortnite-jam-tracks-tracker-shop-post.yml` — ~8:12 AM Bangkok, cron.
  Runs the full daily flow (grid image + update text message).
- `fortnite-jam-tracks-tracker-shop-grid.yml` — **manual only**, no cron.
  Runs just `post-grid` above, for triggering the grid image by itself.

Add `DISCORD_FORTNITE_CHANNEL_ID` as a repo secret alongside the existing
`DISCORD_BOT_TOKEN` to activate all three.

## First run

The very first `check` run has no prior snapshot, so every track currently
in the shop counts as "new" and shows outlined in green on the grid —
that's intentional, so the first grid doubles as a full listing of what's
available right now, with everything highlighted.
