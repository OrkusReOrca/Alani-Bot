// Lets whatever does the actual admissions research (a Claude Code
// session/routine, wherever it runs — not this repo) push its refreshed
// programs.json straight into the live bot process, bypassing git
// entirely for the purpose of actually landing the data.
//
// Why this exists: this feature's data used to reach bot-hosting.net
// purely by being committed to GitHub, on the assumption the host would
// pick it up. It doesn't — bot-hosting.net does not auto-pull on a new
// push, only on a manual restart from its dashboard — so a commit alone
// left the live bot silently reading whatever stale programs.json it
// last booted with, no matter how current the git history looked.
// git remains useful as a version-history/backup trail (keep committing
// there too), but it's no longer what makes an update live — this route
// is.
//
// Registers into the shared bridge server (see common/bridgeServer.js),
// same pattern as db/voiceApi.js's routes, just with its own secret.

import { config } from "./config.js";
import { savePrograms } from "./programs.js";
import { sendJson, readJsonBody } from "../../common/http.js";

async function handlePushPrograms(req, res) {
  const programs = await readJsonBody(req);

  try {
    savePrograms(programs);
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }

  console.log(`[uniTrackerPush] saved ${programs.length} programs — will be posted/diffed at the next scheduled run`);
  sendJson(res, 200, {
    message: `Saved ${programs.length} programs. The next scheduled run (see common/dailyJobs.js) will diff and post any changes.`,
  });
}

export function registerUniTrackerPushRoute(registerRoute) {
  if (!config.pushSecret) {
    console.log("[uniTrackerPush] UNI_TRACKER_PUSH_SECRET not set — push route disabled");
    return;
  }
  registerRoute("POST", "/admin/uni-programs", config.pushSecret, handlePushPrograms);
}
