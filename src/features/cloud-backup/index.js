// Wires the backup service to its real dependencies (Google Drive, the
// live databases, Discord) and exposes the two things the rest of the bot
// needs: a lazily-built service instance, and a catch-up run at startup.

import path from "path";
import { fileURLToPath } from "url";
import * as drive from "../../common/googleDrive.js";
import { isOAuthConfigured } from "../../common/googleAuth.js";
import { createBackupService } from "./service.js";
import { createStateStore } from "./state.js";
import { notifier } from "./notifier.js";
import { BACKUP_GROUPS } from "./groups.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "..", "..", "data", "cloud-backup");
const BACKUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const STARTUP_CATCH_UP_DELAY_MS = 60 * 1000;

const stateStore = createStateStore(path.join(DATA_DIR, "state.json"));
let service = null;

export function isBackupConfigured() {
  return isOAuthConfigured();
}

export function getBackupService() {
  service ??= createBackupService({
    drive,
    groups: BACKUP_GROUPS,
    state: stateStore,
    notifier,
    dataDir: DATA_DIR,
  });
  return service;
}

// Runs the scheduled 6-hourly pass. Skipped (with a log line) until Drive
// access is configured, so a fresh deployment isn't spammed with errors.
export async function runScheduledBackup() {
  if (!isBackupConfigured()) {
    console.log("[cloud-backup] Google OAuth not configured — skipping backup pass");
    return;
  }
  const results = await getBackupService().runAll();
  console.log("[cloud-backup] pass finished:", JSON.stringify(results));
}

// The bot restarts often (every deploy), and a restart across a slot
// boundary would otherwise skip that backup entirely. If the last complete
// pass is more than one interval old, run one shortly after startup.
export function scheduleStartupCatchUp() {
  if (!isBackupConfigured()) return;
  const last = stateStore.lastRunAt();
  if (last && Date.now() - Date.parse(last) < BACKUP_INTERVAL_MS) return;
  setTimeout(() => {
    runScheduledBackup().catch((err) => console.error("[cloud-backup] catch-up pass failed:", err));
  }, STARTUP_CATCH_UP_DELAY_MS).unref();
}
