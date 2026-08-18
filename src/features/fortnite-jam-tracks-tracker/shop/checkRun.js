import { fetchJamTracks } from "./fetchShop.js";
import { loadState, saveState, diffTracks, savePendingDiff } from "./state.js";

async function main() {
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
