// The bot's on/off-able routines. Each routine is a scheduled job; turning
// one off stops it from firing until it's turned back on.
//
// A routine may need more than flipping a flag: the Fortnite tracker runs
// on GitHub's schedule, not in this process, so switching it means
// enabling/disabling its scheduled workflows through the GitHub API. That
// call runs FIRST and the stored setting only changes if it succeeds, so
// the setting never claims a state GitHub isn't actually in.

import { setWorkflowEnabled } from "../../common/githubActions.js";
import { getSetting, setSetting } from "./store.js";
import { ON, OFF } from "./definitions.js";

// The two scheduled workflows. (-refresh.yml and -grid.yml are manual-only
// and stay usable whatever the routine's state.)
const FORTNITE_SCHEDULED_WORKFLOWS = [
  "fortnite-jam-tracks-tracker-shop-check.yml",
  "fortnite-jam-tracks-tracker-shop-post.yml",
];

export const ROUTINES = {
  unitracker: { settingKey: "routine.unitracker", label: "Uni tracker" },
  fortnite: {
    settingKey: "routine.fortnite",
    label: "Fortnite tracker",
    applyExternally: async (enabled) => {
      for (const workflow of FORTNITE_SCHEDULED_WORKFLOWS) await setWorkflowEnabled(workflow, enabled);
    },
  },
};

export function isRoutineEnabled(name) {
  return getSetting(ROUTINES[name].settingKey) === ON;
}

export async function setRoutineEnabled(name, enabled) {
  const routine = ROUTINES[name];
  await routine.applyExternally?.(enabled);
  setSetting(routine.settingKey, enabled ? ON : OFF);
}
