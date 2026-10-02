// Tags attached to Discord user IDs. A tag grants a capability; the only one
// today is AIallowed (may use `.aii` and `.a emo`). Bot owners hold every tag
// implicitly and can't be un-tagged. Stored in the settings database.

import { settingsDb } from "../settings/store.js";
import { isOwner } from "../../common/auth.js";

export const TAGS = {
  AIallowed: "AIallowed",
};

// Case-insensitive lookup of a tag's canonical name, or null.
export function canonicalTag(name) {
  return Object.values(TAGS).find((tag) => tag.toLowerCase() === name?.toLowerCase()) ?? null;
}

export function hasTag(userId, tag) {
  if (isOwner(userId)) return true;
  return Boolean(settingsDb.prepare(`SELECT 1 FROM user_tags WHERE user_id = ? AND tag = ?`).get(userId, tag));
}

// Returns false if the user already had it.
export function addTag(userId, tag, grantedBy) {
  const result = settingsDb
    .prepare(`INSERT OR IGNORE INTO user_tags (user_id, tag, granted_by, granted_at) VALUES (?, ?, ?, ?)`)
    .run(userId, tag, grantedBy, new Date().toISOString());
  return result.changes > 0;
}

// Returns false if the user didn't have a granted copy of it.
export function removeTag(userId, tag) {
  return settingsDb.prepare(`DELETE FROM user_tags WHERE user_id = ? AND tag = ?`).run(userId, tag).changes > 0;
}

export function listTagHolders(tag) {
  return settingsDb.prepare(`SELECT user_id FROM user_tags WHERE tag = ? ORDER BY granted_at`).all(tag).map((r) => r.user_id);
}
