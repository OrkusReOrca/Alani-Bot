import { config } from "./config.js";
import { loadPendingDiff, clearPendingDiff, loadState } from "./state.js";
import { groupNewTrackEmbeds, formatLeftTracksMessage } from "./formatter.js";
import { generateShopGridImage } from "./generateGridImage.js";
import {
  sendEmbedsViaBotChannel,
  sendViaBotChannel,
  sendFileViaBotChannel,
} from "../../common/discordApi.js";

async function main() {
  if (!config.botToken || !config.channelId) {
    throw new Error(
      "Not configured. Set DISCORD_BOT_TOKEN + DISCORD_FORTNITE_CHANNEL_ID in .env"
    );
  }

  const { newTracks, leftTracks } = loadPendingDiff();
  console.log(`Posting: ${newTracks.length} new, ${leftTracks.length} left`);

  for (const embedGroup of groupNewTrackEmbeds(newTracks)) {
    await sendEmbedsViaBotChannel(config.botToken, config.channelId, embedGroup);
  }

  const leftMessage = formatLeftTracksMessage(leftTracks);
  if (leftMessage) {
    await sendViaBotChannel(config.botToken, config.channelId, leftMessage);
  }

  if (newTracks.length === 0 && leftTracks.length === 0) {
    console.log("No changes since yesterday's check — nothing posted.");
  }

  // Grid image goes last, after every text/embed update — built from
  // today's full shop (state.json, already refreshed by this morning's
  // check step), sorted newest-to-oldest by shop add date.
  console.log("Generating shop grid image...");
  const todayTracks = Object.values(loadState()).sort(
    (a, b) => new Date(b.inDate) - new Date(a.inDate)
  );
  const newTrackIds = new Set(newTracks.map((t) => t.id));
  const dateLabel = new Date().toISOString().slice(0, 10);

  const imageBuffer = await generateShopGridImage(todayTracks, newTrackIds, dateLabel);
  await sendFileViaBotChannel(
    config.botToken,
    config.channelId,
    imageBuffer,
    `jam-tracks-shop-${dateLabel}.png`
  );

  clearPendingDiff();
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
