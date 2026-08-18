import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROGRAMS_PATH = path.join(__dirname, "..", "data", "programs.json");

const VALID_STATUSES = new Set(["idle", "open", "closed", "unknown"]);

export function loadPrograms() {
  const raw = fs.readFileSync(PROGRAMS_PATH, "utf-8");
  const programs = JSON.parse(raw);

  for (const p of programs) {
    if (!VALID_STATUSES.has(p.status)) {
      throw new Error(
        `Program "${p.id}" has invalid status "${p.status}". Must be one of: ${[...VALID_STATUSES].join(", ")}`
      );
    }
  }

  return programs;
}
