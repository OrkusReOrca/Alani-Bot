import { config } from "./config.js";
import { loadPendingDiff, clearPendingDiff } from "./state.js";
import { formatNewTrackEmbed, formatLeftTracksMessage } from "./formatter.js";
import { sendEmbedViaBotChannel, sendViaBotChannel } from "../../common/discordApi.js";

async function main() {
  if (!config.botToken || !config.channelId) {
    throw new Error(
      "Not configured. Set DISCORD_BOT_TOKEN + DISCORD_FORTNITE_CHANNEL_ID in .env"
    );
  }

  const { newTracks, leftTracks } = loadPendingDiff();
  console.log(`Posting: ${newTracks.length} new, ${leftTracks.length} left`);

  for (const track of newTracks) {
    await sendEmbedViaBotChannel(config.botToken, config.channelId, formatNewTrackEmbed(track));
  }

  const leftMessage = formatLeftTracksMessage(leftTracks);
  if (leftMessage) {
    await sendViaBotChannel(config.botToken, config.channelId, leftMessage);
  }

  if (newTracks.length === 0 && leftTracks.length === 0) {
    console.log("No changes since yesterday's check — nothing posted.");
  }

  clearPendingDiff();
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
