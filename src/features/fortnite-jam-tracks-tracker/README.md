# Fortnite Jam Tracks Tracker

Daily Discord updates on Fortnite's Jam Tracks — two sub-features, both
posting to the same channel in the friend server, back to back each
morning:

1. **[shop](shop/README.md)** — the purchasable item shop's Jam Tracks
   section. Grid image of everything currently for sale (poster, name,
   price, days left), new/rerun tracks outlined in green, plus a message
   for tracks that left. Runs 7:30 AM (check) and 8:00 AM (post) Bangkok
   time.
2. **[in-play](in-play/README.md)** — everything currently free to play,
   separate from the shop entirely. Grid image, poster + name only, new
   tracks outlined in green. Runs 8:05 AM Bangkok time, right after `shop`
   posts.

Part of the [Alani-Bot](../../../README.md) repo.

## Structure

```
src/features/fortnite-jam-tracks-tracker/
  shop/       purchasable item shop tracking (see shop/README.md)
  in-play/    free-to-play tracking (see in-play/README.md)

data/fortnite-jam-tracks-tracker/
  shop/       shop/state.json, shop/pending-diff.json
  in-play/    in-play/state.json

.github/workflows/
  fortnite-jam-tracks-tracker-shop-check.yml
  fortnite-jam-tracks-tracker-shop-post.yml
  fortnite-jam-tracks-tracker-shop-grid.yml       (manual-only, no cron)
  fortnite-jam-tracks-tracker-in-play-daily.yml
```

The two sub-features are independent — they don't share code beyond
`src/common/discordApi.js` (the same shared Discord sender every feature
in this repo uses) — grouped under one parent folder because they're both
"Jam Tracks" tracking and post to the same channel, not because they
depend on each other.

## Setup

One shared variable for both sub-features — see either sub-README for
details:

| Variable | Where to get it |
|---|---|
| `DISCORD_FORTNITE_CHANNEL_ID` | Right-click the target channel in the friend server → Copy Channel ID. |

`DISCORD_BOT_TOKEN` is shared with every feature in this repo.
