import { config } from "./config.js";
import { sendViaBotChannel } from "../../common/discordApi.js";

async function main() {
  if (!config.botToken || !config.channelId) {
    throw new Error(
      "Not configured. Set DISCORD_BOT_TOKEN + DISCORD_FORTNITE_CHANNEL_ID in .env"
    );
  }

  console.log("Testing channel delivery...");
  await sendViaBotChannel(
    config.botToken,
    config.channelId,
    `✅ Test message from fortnite-jam-tracks-in-play — ${new Date().toISOString()}\nIf you see this, delivery is working.`
  );
  console.log("Test send complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
