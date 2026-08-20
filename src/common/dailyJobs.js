// Runs the daily scheduled jobs that used to live entirely in GitHub
// Actions cron workflows — moved here now that the bot itself is online
// 24/7 on bot-hosting.net, so there's no reason to wait on GitHub's
// Actions queue (seen running 30-48+ minutes late — see the workflow
// files' own comments) for something the bot can just do itself on a
// timer. The GitHub workflows are deactivated (schedule trigger removed,
// workflow_dispatch kept), not deleted — see .github/workflows/*.yml —
// so they're still there as a manual fallback/backfill tool if ever needed.
//
// Same simple poll pattern as orkus-info/scheduler.js: tick every 30s,
// compare against a fixed "HH:MM" ICT time, and run once per calendar day
// (ICT) — a small in-memory last-run-date guard, not persisted, since a
// job firing twice on the rare day the bot restarts in the exact same
// minute is a much smaller problem than the 30-48 minute lateness this
// replaces.

import { run as checkFortniteShop } from "../features/fortnite-jam-tracks-tracker/shop/checkRun.js";
import { run as postFortniteShop } from "../features/fortnite-jam-tracks-tracker/shop/postRun.js";
import { run as runUniUpdater } from "../features/uni-application-updater/run.js";

const CHECK_INTERVAL_MS = 30 * 1000;
const ICT_OFFSET_MINUTES = 7 * 60;

// Same times the GitHub Actions cron schedules used — no longer picked to
// dodge GitHub's own scheduler congestion (an in-process timer has no
// queue to dodge), just kept identical so daily posts keep landing at the
// time users are already used to.
const JOBS = [
  { name: "fortnite-jam-tracks-tracker: shop check", hour: 7, minute: 37, run: checkFortniteShop },
  { name: "fortnite-jam-tracks-tracker: shop post", hour: 8, minute: 12, run: postFortniteShop },
  { name: "uni-application-updater: daily", hour: 9, minute: 19, run: () => runUniUpdater() },
];

function ictNow() {
  const shifted = new Date(Date.now() + ICT_OFFSET_MINUTES * 60 * 1000);
  return {
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    dateKey: shifted.toISOString().slice(0, 10), // ICT calendar date, "YYYY-MM-DD"
  };
}

export function startDailyJobs() {
  const lastRunDate = new Map(); // job name -> ICT dateKey it last ran on

  setInterval(() => {
    const { hour, minute, dateKey } = ictNow();
    for (const job of JOBS) {
      if (hour !== job.hour || minute !== job.minute) continue;
      if (lastRunDate.get(job.name) === dateKey) continue; // already ran today

      lastRunDate.set(job.name, dateKey);
      console.log(`[dailyJobs] running ${job.name}...`);
      job.run().catch((err) => console.error(`[dailyJobs] ${job.name} failed:`, err));
    }
  }, CHECK_INTERVAL_MS);

  console.log("[dailyJobs] daily job scheduler started");
}
