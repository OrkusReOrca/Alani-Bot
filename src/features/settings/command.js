// ".a setting" — owner-only control panel for the bot's settings.
//
//   .a setting                                     overview
//   .a setting routine                             which routines are on/off
//   .a setting routine <name> <setON|setOFF>       switch one
//   .a setting cloud [status|push|resume ...]      cloud backup (see cloud-backup/command.js)
//
// Every change lands in the settings database, so it's change-logged and
// backed up to Google Drive like the rest of the bot's data.

import { isOwner } from "../../common/auth.js";
import { chunkMessage } from "../../common/discordApi.js";
import { handleCloudCommand } from "../cloud-backup/command.js";
import { listSettings } from "./store.js";
import { ROUTINES, isRoutineEnabled, setRoutineEnabled } from "./routines.js";

export const data = {
  name: "setting",
};

const USAGE = [
  "Usage:",
  "`.a setting` — overview",
  "`.a setting routine` — routines and whether they're on",
  "`.a setting routine <" + Object.keys(ROUTINES).join("|") + "> <setON|setOFF>`",
  "`.a setting cloud` — cloud backup (status / push / resume)",
].join("\n");

const stateLabel = (enabled) => (enabled ? "ON" : "OFF");

function describeRoutines() {
  return Object.entries(ROUTINES)
    .map(([name, { label }]) => `• \`${name}\` (${label}): **${stateLabel(isRoutineEnabled(name))}**`)
    .join("\n");
}

function describeOverview() {
  const settings = listSettings().map((s) => `• \`${s.key}\` = **${s.value}** — ${s.description}`);
  return ["**Settings**", ...settings, "", USAGE].join("\n");
}

async function handleRoutine(args) {
  const [name, action] = args;
  if (!name) return describeRoutines();

  const routineName = name.toLowerCase();
  const enabled = { seton: true, setoff: false }[action?.toLowerCase()];
  if (!ROUTINES[routineName] || enabled === undefined) return USAGE;

  try {
    await setRoutineEnabled(routineName, enabled);
  } catch (err) {
    return `Couldn't switch ${routineName} ${stateLabel(enabled)}: ${err.message}`;
  }
  return `${ROUTINES[routineName].label} routine is now **${stateLabel(enabled)}**.`;
}

export async function execute(ctx, args = []) {
  if (!isOwner(ctx.userId)) {
    await ctx.reply("Unauthorized user, no permission");
    return;
  }

  const [section, ...rest] = args;
  let reply;
  switch (section?.toLowerCase()) {
    case undefined:
      reply = describeOverview();
      break;
    case "routine":
      reply = await handleRoutine(rest);
      break;
    case "cloud":
      reply = await handleCloudCommand(rest, ctx);
      break;
    default:
      reply = USAGE;
  }

  for (const chunk of chunkMessage(reply)) await ctx.reply(chunk);
}
