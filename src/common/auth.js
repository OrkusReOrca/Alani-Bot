// Owner allowlist for admin-level features (currently the "db" command —
// see src/features/db/). Deliberately separate from src/common/config.js:
// this is an authorization concern (who's allowed), not a
// where-to-connect concern.

import { readEnv } from "./env.js";

const OWNER_IDS = [readEnv("DISCORD_OWNER_0"), readEnv("DISCORD_OWNER_1")].filter(Boolean);

export function isOwner(userId) {
  return OWNER_IDS.includes(userId);
}

// For display purposes only (e.g. ".a list db"'s Main-tier owner line) —
// isOwner() above remains the actual access check everywhere else.
export function getOwnerIds() {
  return OWNER_IDS;
}
