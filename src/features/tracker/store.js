// The real tracker database (data/tracker/Tracker.db) and the store built on it.
// Backed up as its own group — see cloud-backup/groups.js.

import { DatabaseSync } from "node:sqlite";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createTrackerStore } from "./storeFactory.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "..", "..", "data", "tracker");

fs.mkdirSync(DATA_DIR, { recursive: true });

export const trackerDb = new DatabaseSync(path.join(DATA_DIR, "Tracker.db"));
export const store = createTrackerStore(trackerDb);
export { DATA_DIR as TRACKER_DATA_DIR };
