import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.join(__dirname, "..", "..", "..", "..", "data", "fortnite-jam-tracks-tracker", "in-play", "state.json");

export function loadState() {
  if (!fs.existsSync(STATE_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
}

// No official "date added to the free rotation" field exists for this
// list, so `addedDate` is Alani's own record of the first day it saw each
// track — the day a track first appears here, that's its addedDate, and it
// never changes on later runs. `isNew` is true only on that first day.
export function updateStateAndMarkNew(todayTracks, todayDateLabel) {
  const prevState = loadState();
  const nextState = {};
  const merged = [];

  for (const track of todayTracks) {
    const prev = prevState[track.id];
    const addedDate = prev?.addedDate ?? todayDateLabel;
    const isNew = !prev;

    const record = { ...track, addedDate };
    nextState[track.id] = record;
    merged.push({ ...record, isNew });
  }

  saveState(nextState);
  return merged;
}
