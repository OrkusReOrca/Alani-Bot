import { config } from "./config.js";
import { fetchDailyJamTracks } from "./fetchDailyList.js";
import { updateStateAndMarkNew } from "./state.js";
import { generateInPlayGridImage } from "./generateGridImage.js";
import { sendFileViaBotChannel } from "../../common/discordApi.js";

async function main() {
  if (!config.botToken || !config.channelId) {
    throw new Error(
      "Not configured. Set DISCORD_BOT_TOKEN + DISCORD_FORTNITE_CHANNEL_ID in .env"
    );
  }

  console.log("Fetching today's Jam Tracks in Play...");
  const todayTracks = await fetchDailyJamTracks();
  if (todayTracks.length === 0) {
    throw new Error(
      "Parsed 0 tracks from fortnite.gg/daily-jam-tracks — the page likely changed structure or returned a block page. Not posting an empty grid."
    );
  }
  console.log(`Found ${todayTracks.length} tracks.`);

  const dateLabel = new Date().toISOString().slice(0, 10);
  const withNewFlags = updateStateAndMarkNew(todayTracks, dateLabel);
  const sorted = [...withNewFlags].sort(
    (a, b) => new Date(b.addedDate) - new Date(a.addedDate)
  );

  const imageBuffer = await generateInPlayGridImage(sorted, dateLabel);
  await sendFileViaBotChannel(
    config.botToken,
    config.channelId,
    imageBuffer,
    `jam-tracks-in-play-${dateLabel}.png`
  );

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
