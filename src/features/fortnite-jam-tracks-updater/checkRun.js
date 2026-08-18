import { fetchJamTracks } from "./fetchShop.js";
import { loadState, saveState, diffTracks, savePendingDiff } from "./state.js";

async function main() {
  console.log("Fetching current Jam Tracks shop...");
  const todayTracks = await fetchJamTracks();
  const prevState = loadState();

  // First-ever run: there's no "yesterday" to diff against, so every track
  // would otherwise look "new" and spam ~100 posts. Just establish the
  // baseline silently instead.
  if (Object.keys(prevState).length === 0) {
    console.log(`No prior state — bootstrapping baseline with ${todayTracks.length} tracks, no diff posted.`);
    savePendingDiff({ newTracks: [], leftTracks: [] });
    saveState(todayTracks);
    return;
  }

  const { newTracks, leftTracks } = diffTracks(todayTracks, prevState);
  console.log(`New: ${newTracks.length}, Left: ${leftTracks.length}`);

  savePendingDiff({ newTracks, leftTracks });
  saveState(todayTracks);

  console.log("Check complete — pending diff and state saved.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
