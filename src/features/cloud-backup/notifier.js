// How the backup service talks to the owner: a one-line status update, plus
// (for faults) the full report in the command box channel.

import { config } from "../../common/config.js";
import { sendViaBotChannel } from "../../common/discordApi.js";
import { statusCloudUpdated, statusCloudFaulty } from "../../common/statusLog.js";

const ownerPing = () => (config.ownerZeroId ? `<@${config.ownerZeroId}>` : "");

async function postToCommandBox(text) {
  if (!config.commandBoxChannelId) {
    console.error("[cloud-backup] DISCORD_COMMAND_BOX not set — can't post the fault report");
    return;
  }
  await sendViaBotChannel(config.botToken, config.commandBoxChannelId, text);
}

export const notifier = {
  cloudUpdated: (group) => statusCloudUpdated(group.label),

  async fault(group, report) {
    await statusCloudFaulty(group.label, { ping: ownerPing() });
    await postToCommandBox(report);
  },

  // Each backup pass while a fault is still unanswered: nag, don't re-report.
  faultStillPending: (group) => statusCloudFaulty(`${group.label}, still waiting on your decision in the command box`, { ping: ownerPing() }),
};
