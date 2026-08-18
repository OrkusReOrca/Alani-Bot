# Fortnite Jam Tracks In Play

Daily grid image of every track currently free to play in Fortnite's Jam
Tracks rotation (as opposed to
[fortnite-jam-tracks-updater](../fortnite-jam-tracks-updater/README.md),
which tracks the *purchasable* shop). Posts right after that feature's
daily update, same channel.

Part of the [Alani-Bot](../../../README.md) repo.

## How it works

1. Fetches [fortnite.gg/daily-jam-tracks](https://fortnite.gg/daily-jam-tracks)
   — a plain HTML page listing every track currently free to play. Unlike
   `fortnite.gg/shop`, this specific page isn't behind an active Cloudflare
   challenge; it responds normally to a plain HTTP request as long as a
   real browser User-Agent header is sent (verified by hand — see
   `fetchDailyList.js` for the caveat if that ever changes).
2. Diffs against yesterday's saved list. A track seen for the first time
   gets today's date recorded as its `addedDate` and is flagged `isNew`
   for a green border; a track seen before keeps its original `addedDate`.
   There's no official "date added to the free rotation" field to read —
   this is Alani's own tracking, which is why it only ever reflects "first
   day *we* saw it," not necessarily the true in-game date.
3. Sends one grid image: poster + name only (no artist, no price — this
   list isn't for sale), sorted newest-to-oldest by `addedDate`, black
   background, new tracks outlined in green. Header reads "Jam Tracks in
   Play".
4. No "left the list" message — this feature only reports what's
   currently playable, not departures.

### Why not split "featured" vs "always free"

The original idea was to distinguish always-free tracks from a rotating
"featured" spotlight (green vs. purple border). No reliable public data
source draws that line — the official jam-tracks catalog API has no
free/featured flag, there's no dedicated festival/playlist API for it, and
`fortnite.gg`'s daily list itself doesn't visually separate the two. Rather
than guess or bolt on a fragile heuristic, this feature treats the whole
daily list as one undifferentiated set — simpler and honest about what's
actually knowable, matching this bot's whole approach to uncertain data.

## Setup

Same `.env` as `fortnite-jam-tracks-updater` — no new variables. Reuses
`DISCORD_BOT_TOKEN` and `DISCORD_FORTNITE_CHANNEL_ID`.

## Test delivery

```bash
npm run test-send:fortnite-jam-tracks-in-play
```

## Run manually

```bash
npm run post:fortnite-jam-tracks-in-play
```

## Schedule

`.github/workflows/fortnite-jam-tracks-in-play-daily.yml` — 8:05 AM
Bangkok time (5 minutes after the shop post, so it reliably lands after
it without hard-coupling the two workflows together). Also triggerable
manually via `workflow_dispatch`.
