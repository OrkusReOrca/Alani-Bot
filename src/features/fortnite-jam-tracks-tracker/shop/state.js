import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "..", "..", "..", "data", "fortnite-jam-tracks-tracker", "shop");
const STATE_PATH = path.join(DATA_DIR, "state.json");
const PENDING_DIFF_PATH = path.join(DATA_DIR, "pending-diff.json");
const LAST_GRID_PATH = path.join(DATA_DIR, "last-grid.json");

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

// Where the most recently posted grid image actually lives (url + filename
// of the message attachment), so the ".a fjamtrack shop" on-demand command
// can relay it without needing to know DISCORD_FORTNITE_CHANNEL_ID itself
// or make a Discord API call to search channel history — it just reads
// this. Written by postShopGridImage() right after posting; committed back
// to the repo by the scheduled workflow the same way state.json is, so
// it's already present after any git pull, not just on the machine that
// posted it.
export function saveLastGridImage(attachment) {
  fs.writeFileSync(LAST_GRID_PATH, JSON.stringify(attachment, null, 2), "utf-8");
}

export function loadLastGridImage() {
  if (!fs.existsSync(LAST_GRID_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(LAST_GRID_PATH, "utf-8"));
  } catch {
    return null;
  }
}
