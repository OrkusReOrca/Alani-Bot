import { config } from "./config.js";
import { loadState, loadPendingDiff } from "./state.js";
import { generateShopGridImage } from "./generateGridImage.js";
import { sendFileViaBotChannel } from "../../../common/discordApi.js";

// Builds the grid from today's full shop (state.json, refreshed by the
// most recent check run) and sends it. Green-border "new today" tracks
// come from whatever the pending diff currently holds — if the daily post
// already ran and cleared it, a manual re-trigger just won't highlight
// anything, which is correct: today's new/left status was already reported.
export async function postShopGridImage() {
  if (!config.botToken || !config.channelId) {
    throw new Error(
      "Not configured. Set DISCORD_BOT_TOKEN + DISCORD_FORTNITE_CHANNEL_ID in .env"
    );
  }

  console.log("Generating shop grid image...");
  const todayTracks = Object.values(loadState()).sort(
    (a, b) => new Date(b.inDate) - new Date(a.inDate)
  );
  const { newTracks } = loadPendingDiff();
  const newTrackIds = new Set(newTracks.map((t) => t.id));
  const dateLabel = new Date().toISOString().slice(0, 10);

  const imageBuffer = await generateShopGridImage(todayTracks, newTrackIds, dateLabel);
  await sendFileViaBotChannel(
    config.botToken,
    config.channelId,
    imageBuffer,
    `jam-tracks-shop-${dateLabel}.png`
  );
  console.log("Grid image posted.");
}
