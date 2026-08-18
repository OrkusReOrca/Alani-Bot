import { config } from "./config.js";
import { sendViaDM, sendViaBotChannel } from "../../common/discordApi.js";

async function main() {
  const message = `✅ Test message from uni-admissions-bot — ${new Date().toISOString()}\nIf you see this, delivery is working.`;

  let sentSomewhere = false;

  if (config.botToken && config.channelId) {
    console.log("Testing bot channel delivery...");
    await sendViaBotChannel(config.botToken, config.channelId, message);
    console.log("Bot channel OK.");
    sentSomewhere = true;
  } else {
    console.log("Skipping channel test (DISCORD_BOT_TOKEN / DISCORD_CHANNEL_ID not set).");
  }

  if (config.botToken && config.userId) {
    console.log("Testing bot DM delivery...");
    await sendViaDM(config.botToken, config.userId, message);
    console.log("Bot DM OK.");
    sentSomewhere = true;
  } else {
    console.log("Skipping bot DM test (DISCORD_BOT_TOKEN / DISCORD_USER_ID not set).");
  }

  if (!sentSomewhere) {
    throw new Error("Nothing configured to test. Fill in .env first (see .env.example).");
  }

  console.log("Test send complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
