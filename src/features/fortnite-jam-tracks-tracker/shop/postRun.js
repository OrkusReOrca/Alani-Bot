import { config } from "./config.js";
import { loadPendingDiff, clearPendingDiff } from "./state.js";
import { formatLeftTracksMessage } from "./formatter.js";
import { postShopGridImage } from "./postGridImage.js";
import { sendViaBotChannel } from "../../../common/discordApi.js";

async function main() {
  if (!config.botToken || !config.channelId) {
    throw new Error(
      "Not configured. Set DISCORD_BOT_TOKEN + DISCORD_FORTNITE_CHANNEL_ID in .env"
    );
  }

  const { newTracks, leftTracks } = loadPendingDiff();
  console.log(`Posting: ${newTracks.length} new, ${leftTracks.length} left`);

  // 1. Grid summary — shows every track currently in the shop, with new
  //    tracks outlined in green and each cell's days-left, so it doubles
  //    as the "what's new" announcement without a separate flood of
  //    per-track messages.
  await postShopGridImage();

  // 2. Left tracks — one combined message, names only.
  const leftMessage = formatLeftTracksMessage(leftTracks);
  if (leftMessage) {
    await sendViaBotChannel(config.botToken, config.channelId, leftMessage);
  }

  clearPendingDiff();
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
