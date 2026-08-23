import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROGRAMS_PATH = path.join(__dirname, "..", "..", "..", "data", "uni-application-updater", "programs.json");

const VALID_STATUSES = new Set(["idle", "open", "closed", "error"]);

function validatePrograms(programs) {
  if (!Array.isArray(programs)) {
    throw new Error("Programs must be a JSON array");
  }
  for (const p of programs) {
    if (!p.id) {
      throw new Error(`Program missing required "id" field: ${JSON.stringify(p)}`);
    }
    if (!VALID_STATUSES.has(p.status)) {
      throw new Error(
        `Program "${p.id}" has invalid status "${p.status}". Must be one of: ${[...VALID_STATUSES].join(", ")}`
      );
    }
  }
}

export function loadPrograms() {
  const raw = fs.readFileSync(PROGRAMS_PATH, "utf-8");
  const programs = JSON.parse(raw);
  validatePrograms(programs);
  return programs;
}

// Used by pushApi.js's /admin/uni-programs route — the research routine
// (running outside this host, wherever that is) pushes its refreshed
// data here directly instead of only committing it to git, since
// bot-hosting.net doesn't auto-pull/restart on a new push (see that
// route's own comment for the full story).
export function savePrograms(programs) {
  validatePrograms(programs);
  fs.writeFileSync(PROGRAMS_PATH, JSON.stringify(programs, null, 2), "utf-8");
}
