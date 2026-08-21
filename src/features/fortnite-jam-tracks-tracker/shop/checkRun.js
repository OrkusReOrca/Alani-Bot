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

// CLI entry point, used by the GitHub Actions workflow via
// `npm run check:fortnite-jam-tracks-tracker-shop` (guarded so this only
// fires when the file is actually run as a script, not on import — a
// leftover from a brief attempt at running this in-process on the bot,
// reverted because postRun.js needs the `canvas` native module, which
// bot-hosting.net's script policy blocks from building; see
// common/dailyJobs.js).
if (fileURLToPath(import.meta.url) === process.argv[1]) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
