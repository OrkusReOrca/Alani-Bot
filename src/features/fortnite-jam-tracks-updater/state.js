import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "..", "..", "data", "fortnite-jam-tracks-updater");
const STATE_PATH = path.join(DATA_DIR, "state.json");
const PENDING_DIFF_PATH = path.join(DATA_DIR, "pending-diff.json");

export function loadState() {
  if (!fs.existsSync(STATE_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));
  } catch {
    return {};
  }
}

export function saveState(tracks) {
  const state = {};
  for (const t of tracks) state[t.id] = t;
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
}

// New = present today, absent from yesterday's stored state.
// Left = present in yesterday's stored state, absent today.
export function diffTracks(todayTracks, prevState) {
  const todayIds = new Set(todayTracks.map((t) => t.id));
  const prevIds = new Set(Object.keys(prevState));

  const newTracks = todayTracks.filter((t) => !prevIds.has(t.id));
  const leftTracks = Object.values(prevState).filter((t) => !todayIds.has(t.id));

  return { newTracks, leftTracks };
}

export function savePendingDiff(diff) {
  fs.writeFileSync(PENDING_DIFF_PATH, JSON.stringify(diff, null, 2), "utf-8");
}

export function loadPendingDiff() {
  if (!fs.existsSync(PENDING_DIFF_PATH)) return { newTracks: [], leftTracks: [] };
  try {
    return JSON.parse(fs.readFileSync(PENDING_DIFF_PATH, "utf-8"));
  } catch {
    return { newTracks: [], leftTracks: [] };
  }
}

export function clearPendingDiff() {
  savePendingDiff({ newTracks: [], leftTracks: [] });
}
