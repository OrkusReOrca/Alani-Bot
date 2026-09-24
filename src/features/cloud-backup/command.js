// The `cloud` section of `.a setting` — inspect the cloud backup, run one
// now, and answer a fault. Returns the reply text; the settings command owns
// authorization and actually sending it.

import { config } from "../../common/config.js";
import { RESOLUTIONS } from "./service.js";
import { getBackupService, isBackupConfigured } from "./index.js";

const USAGE = [
  "Usage:",
  "`.a setting cloud` — status of the cloud backup",
  "`.a setting cloud push` — back up now (verify + save if anything changed)",
  "`.a setting cloud resume <cloud|host> [db|settings]` — answer a fault (command box only)",
].join("\n");

const NOT_CONFIGURED =
  "Cloud backup isn't set up yet — set DISCORD_BACKUP_CHANNEL and BACKUP_ENCRYPTION_KEY (see the cloud-backup README).";

function describeOutcome({ groupId, outcome, error }) {
  const text = {
    baseline: "first backup uploaded",
    uploaded: "changes uploaded as a new instance",
    unchanged: "no changes since the last instance",
    fault: "FAULT detected — see the command box",
    "pending-fault": "paused, still waiting on your decision",
    error: `failed — ${error}`,
    busy: "a backup pass is already running",
  }[outcome];
  return groupId ? `• \`${groupId}\`: ${text}` : text;
}

async function resume(args, ctx) {
  if (ctx.channelId !== config.commandBoxChannelId) return "Answer a cloud fault in the command box channel only.";

  const [choice, groupArg] = args.map((a) => a.toLowerCase());
  if (!RESOLUTIONS.includes(choice)) return USAGE;

  const service = getBackupService();
  const pending = service.pendingGroupIds();
  const groupId = groupArg ?? (pending.length === 1 ? pending[0] : null);
  if (!groupId) {
    return pending.length === 0
      ? "There's no unresolved cloud fault."
      : `More than one group has a fault (${pending.join(", ")}) — say which: \`.a setting cloud resume ${choice} <group>\``;
  }
  return service.resolveFault(groupId, choice);
}

export async function handleCloudCommand(args, ctx) {
  const [action, ...rest] = args;
  if (!isBackupConfigured()) return NOT_CONFIGURED;

  switch (action?.toLowerCase()) {
    case undefined:
    case "status":
      return getBackupService().describeStatus();
    case "push":
      return (await getBackupService().runAll()).map(describeOutcome).join("\n");
    case "resume":
      return resume(rest, ctx);
    default:
      return USAGE;
  }
}
