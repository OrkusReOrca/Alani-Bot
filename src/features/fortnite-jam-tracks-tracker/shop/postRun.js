import { fileURLToPath } from "url";
import { config } from "./config.js";
import { loadPendingDiff, clearPendingDiff } from "./state.js";
import { formatUpdateMessage } from "./formatter.js";
import { postShopGridImage } from "./postGridImage.js";
import { sendViaBotChannel } from "../../../common/discordApi.js";

export async function run() {
  if (!config.botToken || !config.channelId) {
    throw new Error(
      "Not configured. Set DISCORD_BOT_TOKEN + DISCORD_FORTNITE_CHANNEL_ID in .env"
    );
  }

  const { newTracks, leftTracks } = loadPendingDiff();
  console.log(`Posting: ${newTracks.length} new, ${leftTracks.length} left`);

  // 1. Grid summary — shows every track currently in the shop, with new
  //    tracks outlined in green and each cell's days-left.
  await postShopGridImage();

  // 2. One combined update message: 🟢+ new tracks (with days left), then
  //    🔴+ tracks that left (name only). Skipped entirely if nothing
  //    changed since yesterday.
  const updateMessage = formatUpdateMessage(newTracks, leftTracks);
  if (updateMessage) {
    await sendViaBotChannel(config.botToken, config.channelId, updateMessage);
  }

  clearPendingDiff();
  console.log("Done.");
}

// CLI entry point, used by the GitHub Actions workflow via
// `npm run post:fortnite-jam-tracks-tracker-shop` — this needs the
// `canvas` native module (via postShopGridImage.js), which is exactly
// why this stays a GitHub Actions script rather than running in-process
// on bot-hosting.net; see common/dailyJobs.js.
if (fileURLToPath(import.meta.url) === process.argv[1]) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
