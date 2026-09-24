// The backup's own small runtime state, kept in a JSON file (deliberately
// NOT in a backed-up database: writing "last run at" into a database that
// is itself fingerprinted would make every run look like a change).
//
//   lastRunAt — when the last complete backup pass finished
//   pending   — unresolved faults, keyed by group id, each holding what the
//               owner needs to decide (see service.js)

import fs from "fs";
import path from "path";

export function createStateStore(filePath) {
  const read = () => {
    try {
      return { lastRunAt: null, pending: {}, ...JSON.parse(fs.readFileSync(filePath, "utf8")) };
    } catch {
      return { lastRunAt: null, pending: {} };
    }
  };
  const write = (state) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
  };

  return {
    lastRunAt: () => read().lastRunAt,
    markRun: (date) => write({ ...read(), lastRunAt: date.toISOString() }),
    pending: (groupId) => read().pending[groupId] ?? null,
    allPending: () => read().pending,
    setPending: (groupId, fault) => {
      const state = read();
      write({ ...state, pending: { ...state.pending, [groupId]: fault } });
    },
    clearPending: (groupId) => {
      const state = read();
      const pending = { ...state.pending };
      delete pending[groupId];
      write({ ...state, pending });
    },
  };
}
