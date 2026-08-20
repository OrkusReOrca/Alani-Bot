import { config } from "./config.js";
import { loadState, loadPendingDiff, saveLastGridImage } from "./state.js";
import { generateShopGridImage } from "./generateGridImage.js";
import { sendFileViaBotChannel } from "../../../common/discordApi.js";

// Builds the grid from today's full shop (state.json, refreshed by the
// most recent check run). Green-border "new today" tracks come from
// whatever the pending diff currently holds — if the daily post already
// ran and cleared it, this just won't highlight anything, which is
// correct: today's new/left status was already reported.
async function buildShopGridImageBuffer() {
  const todayTracks = Object.values(loadState()).sort(
    (a, b) => new Date(b.inDate) - new Date(a.inDate)
  );
  const { newTracks } = loadPendingDiff();
  const newTrackIds = new Set(newTracks.map((t) => t.id));
  const dateLabel = new Date().toISOString().slice(0, 10);

  const imageBuffer = await generateShopGridImage(todayTracks, newTrackIds, dateLabel);
  return { imageBuffer, dateLabel };
}

// Posts the grid to the configured Fortnite tracking channel — used by the
// scheduled workflow (postGridRun.js/postRun.js). Also records where it
// landed (state.js's saveLastGridImage) so the ".a fjamtrack shop" command
// can relay this exact image on demand without regenerating it (that needs
// `canvas`, which isn't reliably buildable on every host — see
// command.js) or needing to know the tracking channel itself.
export async function postShopGridImage() {
  if (!config.botToken || !config.channelId) {
    throw new Error(
      "Not configured. Set DISCORD_BOT_TOKEN + DISCORD_FORTNITE_CHANNEL_ID in .env"
    );
  }

  console.log("Generating shop grid image...");
  const { imageBuffer, dateLabel } = await buildShopGridImageBuffer();
  const filename = `jam-tracks-shop-${dateLabel}.png`;
  const message = await sendFileViaBotChannel(config.botToken, config.channelId, imageBuffer, filename);

  const attachment = message?.attachments?.[0];
  if (attachment) {
    saveLastGridImage({ url: attachment.url, filename: attachment.filename });
  }
  console.log("Grid image posted.");
}
