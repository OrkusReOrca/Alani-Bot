import { fileURLToPath } from "url";
import { config } from "./config.js";
import { loadPrograms } from "./programs.js";
import { loadState, saveState, diffPrograms, stateFromPrograms } from "./state.js";
import { formatDailyMessage, formatChangeAlert } from "./formatter.js";
import { sendViaDM, sendViaBotChannel } from "../../common/discordApi.js";

// forceDm: true for a manual/verification run (was previously only the
// GitHub Actions workflow_dispatch case, via FORCE_DM=true) — sends a
// DM even with no status change, just to confirm delivery still works.
// The persistent bot's daily timer (see common/dailyJobs.js) always
// calls run() with no argument, matching the old scheduled-cron behavior.
export async function run(forceDm = process.env.FORCE_DM === "true") {
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
  const shouldDM = changeAlert || forceDm;

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

// CLI entry point — still used by the (now-deactivated) GitHub Actions
// workflow via `npm run start:uni-application-updater`. The persistent
// bot instead imports and calls run() directly — see common/dailyJobs.js.
if (fileURLToPath(import.meta.url) === process.argv[1]) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
