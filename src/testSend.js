import { config } from "./config.js";
import { sendViaWebhook, sendViaDM, sendViaBotChannel } from "./discordSender.js";

async function main() {
  const message = `✅ Test message from uni-admissions-bot — ${new Date().toISOString()}\nIf you see this, delivery is working.`;

  let sentSomewhere = false;

  if (config.webhookUrl) {
    console.log("Testing webhook delivery...");
    await sendViaWebhook(config.webhookUrl, message);
    console.log("Webhook OK.");
    sentSomewhere = true;
  } else {
    console.log("Skipping webhook test (DISCORD_WEBHOOK_URL not set).");
  }

  if (config.botToken && config.userId) {
    console.log("Testing bot DM delivery...");
    await sendViaDM(config.botToken, config.userId, message);
    console.log("Bot DM OK.");
    sentSomewhere = true;
  } else {
    console.log("Skipping bot DM test (DISCORD_BOT_TOKEN / DISCORD_USER_ID not set).");
  }

  if (config.botToken && config.channelId) {
    console.log("Testing bot channel delivery...");
    await sendViaBotChannel(config.botToken, config.channelId, message);
    console.log("Bot channel OK.");
    sentSomewhere = true;
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
