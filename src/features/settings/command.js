// ".a setting" — owner-only control panel for the bot's settings.
//
//   .a setting                                     overview
//   .a setting routine                             which routines are on/off
//   .a setting routine <name> <setON|setOFF>       switch one
//   .a setting cloud [status|push|resume ...]      cloud backup (see cloud-backup/command.js)
//
// Every change lands in the settings database, so it's change-logged and
// backed up (encrypted) to the backup channel like the rest of the bot's data.

import { isOwner } from "../../common/auth.js";
import { chunkMessage } from "../../common/discordApi.js";
import { handleCloudCommand } from "../cloud-backup/command.js";
import { listSettings, getSetting, setSetting } from "./store.js";
import { ON, OFF, PLAY_CALL_KEY } from "./definitions.js";
import { ROUTINES, isRoutineEnabled, setRoutineEnabled } from "./routines.js";

export const data = {
  name: "setting",
};

export const aiGuide = `
.a setting                                  — overview of settings (owners only)
.a setting routine                          — which routines are on/off
.a setting routine <unitracker|fortnite> <setON|setOFF>  — switch a routine (unitracker = daily uni admissions post; fortnite = Fortnite shop post)
.a setting playcall                         — whether the voice player posts "Now playing" messages
.a setting playcall on|off                  — turn those messages on or off (off: the player stays quiet when a track starts)
.a setting cloud                            — status of the encrypted cloud backup
.a setting cloud push                       — back up now
.a setting cloud resume <cloud|host> [db|settings|ai-history|voice] — answer a backup fault (command box channel only)
All owner-only.`;

// Answering a backup fault discards one side's data.
export const isDestructive = (args) => args[0]?.toLowerCase() === "cloud" && args[1]?.toLowerCase() === "resume";

const USAGE = [
  "Usage:",
  "`.a setting` — overview",
  "`.a setting routine` — routines and whether they're on",
  "`.a setting routine <" + Object.keys(ROUTINES).join("|") + "> <setON|setOFF>`",
  "`.a setting playcall [on|off]` — the voice player's \"Now playing\" messages",
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

function handlePlayCall(args) {
  const [value] = args.map((a) => a.toLowerCase().replace(/^set/, ""));
  if (value === undefined) return `PlayCall is **${getSetting(PLAY_CALL_KEY).toUpperCase()}** — the voice player ${getSetting(PLAY_CALL_KEY) === ON ? "posts" : "doesn't post"} "Now playing" messages.`;
  if (![ON, OFF].includes(value)) return USAGE;
  setSetting(PLAY_CALL_KEY, value);
  return `PlayCall is now **${value.toUpperCase()}**${value === OFF ? " — \"Now playing\" messages are off (errors and leave notices still post)." : "."}`;
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
    case "playcall":
      reply = handlePlayCall(rest);
      break;
    case "cloud":
      reply = await handleCloudCommand(rest, ctx);
      break;
    default:
      reply = USAGE;
  }

  for (const chunk of chunkMessage(reply)) await ctx.reply(chunk);
}
