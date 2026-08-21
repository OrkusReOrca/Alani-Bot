# Fortnite Jam Tracks Tracker

Daily Discord updates on Fortnite's Jam Tracks, posted to a channel in the
friend server.

1. **[shop](shop/README.md)** — the purchasable item shop's Jam Tracks
   section. Grid image of everything currently for sale (poster, name,
   price, days left), new/rerun tracks outlined in green, plus a message
   for tracks that left. Runs 7:37 AM (check) and 8:12 AM (post) Bangkok
   time via GitHub Actions cron — NOT in-process on the persistent bot,
   unlike some other daily jobs in this repo; see the root README's
   "Daily jobs" section for why.

Part of the [Alani-Bot](../../../README.md) repo.

## Structure

```
src/features/fortnite-jam-tracks-tracker/
  shop/       purchasable item shop tracking (see shop/README.md)

data/fortnite-jam-tracks-tracker/
  shop/       shop/state.json, shop/pending-diff.json

.github/workflows/
  fortnite-jam-tracks-tracker-shop-check.yml
  fortnite-jam-tracks-tracker-shop-post.yml
  fortnite-jam-tracks-tracker-shop-grid.yml       (manual-only, no cron)
```

`check`/`post` briefly moved in-process on the persistent bot's daily
timer (`src/common/dailyJobs.js`) but were moved back — `post` needs the
`canvas` native module to draw the grid image, and bot-hosting.net's
script policy blocks native-module builds (confirmed the hard way:
`Cannot find module '../build/Release/canvas.node'` in production). Both
workflows' `schedule:` trigger is active again. See shop/README.md's
"Schedule" section and the root README's "Daily jobs" section.

This is grouped under a parent `fortnite-jam-tracks-tracker/` folder
(rather than being a bare top-level feature) so a related sub-feature can
be added alongside `shop/` later without another restructure — see below.

## Setup

| Variable | Where to get it |
|---|---|
| `DISCORD_FORTNITE_CHANNEL_ID` | Right-click the target channel in the friend server → Copy Channel ID. |

`DISCORD_BOT_TOKEN` is shared with every feature in this repo.

## Shelved: "in play" (free-to-play tracks)

A second sub-feature was attempted — a daily grid of every Jam Track
currently free to play (separate from the purchasable shop above), sourced
from `fortnite.gg/daily-jam-tracks`. It was removed after the only page
with this data proved unreliable to fetch from GitHub Actions:

- No official API (fortnite-api.com's cosmetics/tracks catalog, its shop
  endpoint, its playlists endpoint) exposes any free/featured/playable
  distinction at all — this data simply isn't published as structured data
  anywhere except that one fan-site page.
- That page itself is server-rendered HTML with no backing JSON API to
  fall back to (confirmed via network trace).
- It responded fine (200) to manual testing, but returned 403 specifically
  when fetched from a GitHub Actions runner — GitHub's runner IP ranges are
  well-known and get flagged harder by Cloudflare than other networks.
  Confirmed this wasn't a fixable header/fingerprint issue by testing with
  a full realistic header set, which made no difference.

Revisit only if a genuine structured data source appears — not worth
re-attempting the same scrape, and not worth adding a proxy service or
routing this specific fetch through a paid/costly path for a fun side
feature.
