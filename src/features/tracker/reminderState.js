// Runtime state of the reminders, in a small JSON file that is deliberately NOT
// part of the backed-up Tracker.db (it changes with every reminder, which would
// make every reminder a "change" for the cloud backup):
//
//   fired    schedule key -> the latest firing already handled (ms). A reminder
//            fires at most once per occurrence, and a restart doesn't repeat it.
//   pending  user id -> the pills their latest DM reminder asked about, so a plain
//            "yes" / "no" reply in the DM can log them.

import fs from "fs";
import path from "path";

const PENDING_LIFETIME_MS = 12 * 60 * 60 * 1000;

export function createReminderState(filePath) {
  let data = { fired: {}, pending: {} };
  try {
    data = { fired: {}, pending: {}, ...JSON.parse(fs.readFileSync(filePath, "utf8")) };
  } catch {
    // first run, or an unreadable file: start clean
  }

  const save = () => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data));
  };

  return {
    firedAt: (key) => data.fired[key] ?? 0,
    markFired(key, ms) {
      data.fired[key] = ms;
      save();
    },
    forget(key) {
      delete data.fired[key];
      save();
    },

    // A newer question replaces an older unanswered one.
    setPending(userId, prompt, nowMs) {
      data.pending[userId] = { ...prompt, expiresAt: nowMs + PENDING_LIFETIME_MS };
      save();
    },
    // Returns the user's waiting question (and clears it), or null if none / expired.
    takePending(userId, nowMs) {
      const prompt = data.pending[userId];
      if (!prompt) return null;
      delete data.pending[userId];
      save();
      return prompt.expiresAt > nowMs ? prompt : null;
    },
    hasPending: (userId, nowMs) => (data.pending[userId]?.expiresAt ?? 0) > nowMs,
  };
}
