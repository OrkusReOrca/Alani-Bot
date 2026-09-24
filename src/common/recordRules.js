// Rules shared by every reminders/events implementation (orkus-info's Main
// database and the tiered ones — see recordActions.js).

// Same-ish record within an hour of each other counts as a likely
// duplicate — narrow enough that two genuinely different reminders/events
// an hour apart don't collide, wide enough to catch "did I already add
// this" re-entry.
export const DEDUP_WINDOW_MS = 60 * 60 * 1000;

// Event length when no end time is given.
export const DEFAULT_EVENT_DURATION_MS = 60 * 60 * 1000;
