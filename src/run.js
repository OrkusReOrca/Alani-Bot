import { config } from "./config.js";
import { loadPrograms } from "./programs.js";
import { loadState, saveState, diffPrograms, stateFromPrograms } from "./state.js";
import { formatDailyMessage, formatChangeAlert } from "./formatter.js";
import { sendViaWebhook, sendViaDM, sendViaBotChannel } from "./discordSender.js";

async function main() {
  const programs = loadPrograms();
  const prevState = loadState();
  const diffMap = diffPrograms(programs, prevState);

  // 1. Daily channel update — always sent, every run.
  const dailyMessage = formatDailyMessage(programs, diffMap);
  let channelSent = false;

  if (config.webhookUrl) {
    console.log("Sending daily update via webhook...");
    await sendViaWebhook(config.webhookUrl, dailyMessage);
    channelSent = true;
  }
  if (config.botToken && config.channelId) {
    console.log("Sending daily update via bot to channel...");
    await sendViaBotChannel(config.botToken, config.channelId, dailyMessage);
    channelSent = true;
  }
  if (!channelSent) {
    throw new Error(
      "No channel delivery configured. Set DISCORD_WEBHOOK_URL and/or DISCORD_BOT_TOKEN + DISCORD_CHANNEL_ID in .env"
    );
  }

  // 2. DM alert — only sent when at least one program's status actually changed.
  const changeAlert = formatChangeAlert(programs, diffMap);
  if (changeAlert) {
    if (config.botToken && config.userId) {
      console.log("Status change detected — sending DM alert...");
      await sendViaDM(config.botToken, config.userId, changeAlert);
    } else {
      console.warn(
        "Status change detected but DISCORD_BOT_TOKEN / DISCORD_USER_ID not set — skipping DM alert."
      );
    }
  } else {
    console.log("No status changes since last run — no DM sent.");
  }

  saveState(stateFromPrograms(programs));
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
