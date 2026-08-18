import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.join(__dirname, "..", "data", "state.json");

export function loadState() {
  if (!fs.existsSync(STATE_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));
  } catch {
    return {};
  }
}

export function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
}

// Returns a diff map: { [programId]: { changed: bool, isNew: bool, prev: {...} | null } }
// `changed` is only true when a prior status actually differs — a program
// seen for the first time (no prior state) is `isNew`, not `changed`, so
// the very first run doesn't fire a DM alert for every program.
export function diffPrograms(programs, prevState) {
  const diff = {};
  for (const p of programs) {
    const prev = prevState[p.id];
    const isNew = !prev;
    const changed =
      !isNew &&
      (prev.status !== p.status ||
        prev.openDate !== p.openDate ||
        prev.closeDate !== p.closeDate);
    diff[p.id] = { changed, isNew, prev: prev || null };
  }
  return diff;
}

export function stateFromPrograms(programs) {
  const state = {};
  for (const p of programs) {
    state[p.id] = {
      status: p.status,
      openDate: p.openDate,
      closeDate: p.closeDate,
    };
  }
  return state;
}
