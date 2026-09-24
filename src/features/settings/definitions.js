// Every setting the bot knows about, with its default and what it does.
// Settings are stored as strings in the settings database (store.js); the
// value sets here are the only values the store will accept.

export const ON = "on";
export const OFF = "off";

export const SETTING_DEFINITIONS = {
  "routine.unitracker": {
    default: ON,
    allowed: [ON, OFF],
    description: "Daily uni-admissions tracker post (runs in-process, see common/dailyJobs.js)",
  },
  "routine.fortnite": {
    default: ON,
    allowed: [ON, OFF],
    description: "Fortnite Jam Tracks shop check + post (runs as scheduled GitHub Actions workflows)",
  },
};
