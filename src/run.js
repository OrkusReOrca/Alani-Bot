import { config } from "./config.js";
import { loadPrograms } from "./programs.js";
import { loadState, saveState, diffPrograms, stateFromPrograms } from "./state.js";
import { formatDailyMessage, formatChangeAlert } from "./formatter.js";
import { sendViaDM, sendViaBotChannel } from "./discordSender.js";

const isManualRun = process.env.FORCE_DM === "true";

async function main() {
  const programs = loadPrograms();
  const prevState = loadState();
  const diffMap = diffPrograms(programs, prevState);

  // 1. Daily channel update — always sent, every run, via the bot.
  if (!config.botToken || !config.channelId) {
    throw new Error(
      "Channel delivery not configured. Set DISCORD_BOT_TOKEN + DISCORD_CHANNEL_ID in .env"
    );
  }
  console.log("Sending daily update via bot to channel...");
  const dailyMessage = formatDailyMessage(programs, diffMap);
  await sendViaBotChannel(config.botToken, config.channelId, dailyMessage);

  // 2. DM alert — sent when a program's status actually changed, or when
  //    manually triggered (workflow_dispatch) so delivery can be verified
  //    on demand even if nothing changed.
  const changeAlert = formatChangeAlert(programs, diffMap);
  const shouldDM = changeAlert || isManualRun;

  if (shouldDM) {
    if (config.botToken && config.userId) {
      console.log(changeAlert ? "Status change detected — sending DM alert..." : "Manual run — sending DM to verify delivery...");
      const dmMessage =
        changeAlert ??
        "✅ Manual run check — no status changes right now, but DM delivery is working.";
      await sendViaDM(config.botToken, config.userId, dmMessage);
    } else {
      console.warn(
        "DM alert needed but DISCORD_BOT_TOKEN / DISCORD_USER_ID not set — skipping."
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
