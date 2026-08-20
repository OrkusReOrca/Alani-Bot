import { fileURLToPath } from "url";
import { fetchJamTracks } from "./fetchShop.js";
import { loadState, saveState, diffTracks, savePendingDiff } from "./state.js";

export async function run() {
  console.log("Fetching current Jam Tracks shop...");
  const todayTracks = await fetchJamTracks();
  const prevState = loadState();

  // First-ever run: there's no "yesterday" state, so every track currently
  // in the shop counts as "new" — it'll show outlined in green on the grid
  // image rather than as individual posts.
  const { newTracks, leftTracks } = diffTracks(todayTracks, prevState);
  console.log(`New: ${newTracks.length}, Left: ${leftTracks.length}`);

  savePendingDiff({ newTracks, leftTracks });
  saveState(todayTracks);

  console.log("Check complete — pending diff and state saved.");
}

// CLI entry point — still used by the (now-deactivated) GitHub Actions
// workflow via `npm run check:fortnite-jam-tracks-tracker-shop`. The
// persistent bot instead imports and calls run() directly on a timer —
// see common/dailyJobs.js — so this only fires when the file is actually
// run as a script, not when it's imported.
if (fileURLToPath(import.meta.url) === process.argv[1]) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
