// Runs the bot's scheduled jobs on an in-process timer. The bot is online
// 24/7 on bot-hosting.net, so there's no reason to wait on GitHub's Actions
// queue (seen running 30-48+ minutes late — see the workflow files' own
// comments) for something the bot can just do itself.
//
// fortnite-jam-tracks-tracker's shop check/post is NOT here, even though it
// was originally moved here too — reverted back to GitHub Actions (see
// fortnite-jam-tracks-tracker-shop-check.yml/-post.yml) because `postRun.js`
// needs the `canvas` native module to draw the grid image, and
// bot-hosting.net's script policy blocks native-module builds — this is the
// exact same constraint command.js's ".a fjamtrack shop" already works
// around by never regenerating the grid live on this host. GitHub Actions'
// runners can build canvas fine (apt-get + npm install, see that workflow's
// own steps), so that job has to stay there. Its on/off switch lives in
// features/settings/routines.js.
//
// Same simple poll pattern as orkus-info/scheduler.js: tick every 30s and
// run each job once per scheduled ICT clock time (guarded by an in-memory
// "already ran this slot" set — not persisted, since a job firing twice on
// the rare day the bot restarts in the exact same minute is a much smaller
// problem than the lateness this replaces).

import { run as runUniUpdater } from "../features/uni-application-updater/run.js";
import { runScheduledBackup } from "../features/cloud-backup/index.js";
import { isRoutineEnabled } from "../features/settings/routines.js";
import { ictParts } from "./time.js";

const CHECK_INTERVAL_MS = 30 * 1000;

// times: ICT "HH:MM" slots. routine: the on/off routine (features/settings/
// routines.js) that gates the job, if any.
const JOBS = [
  // Same time the GitHub Actions cron schedule used, so the daily post keeps
  // landing when people are used to it.
  { name: "uni-application-updater: daily", times: ["09:19"], routine: "unitracker", run: () => runUniUpdater() },
  // Every 6 hours from midnight.
  { name: "cloud-backup", times: ["00:00", "06:00", "12:00", "18:00"], run: runScheduledBackup },
];

export function startDailyJobs() {
  const lastSlot = new Map(); // job name -> "<ICT date> <HH:MM>" it last fired for

  setInterval(() => {
    const { year, month, day, hour, minute } = ictParts(Date.now());
    const clock = `${hour}:${minute}`;

    for (const job of JOBS) {
      if (!job.times.includes(clock)) continue;
      const slot = `${year}-${month}-${day} ${clock}`;
      if (lastSlot.get(job.name) === slot) continue;
      lastSlot.set(job.name, slot);

      if (job.routine && !isRoutineEnabled(job.routine)) {
        console.log(`[dailyJobs] skipping ${job.name} — routine "${job.routine}" is off`);
        continue;
      }
      console.log(`[dailyJobs] running ${job.name}...`);
      job.run().catch((err) => console.error(`[dailyJobs] ${job.name} failed:`, err));
    }
  }, CHECK_INTERVAL_MS);

  console.log("[dailyJobs] job scheduler started");
}
