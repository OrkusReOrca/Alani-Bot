// Wires the backup service to its real dependencies (the encrypted Discord
// backup channel, the live databases, the owner notifier) and exposes what the
// rest of the bot needs: the service, and the backup-run entry points.

import path from "path";
import { fileURLToPath } from "url";
import { config } from "../../common/config.js";
import { createBackupService } from "./service.js";
import { createStateStore } from "./state.js";
import { createDiscordStore } from "./discordStore.js";
import { parseKey } from "./crypto.js";
import { notifier } from "./notifier.js";
import { BACKUP_GROUPS } from "./groups.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "..", "..", "data", "cloud-backup");

const stateStore = createStateStore(path.join(DATA_DIR, "state.json"));
let service = null;

export function isBackupConfigured() {
  return Boolean(config.botToken && config.backupChannelId && config.backupEncryptionKey);
}

export function getBackupService() {
  service ??= createBackupService({
    store: createDiscordStore({
      botToken: config.botToken,
      channelId: config.backupChannelId,
      key: parseKey(config.backupEncryptionKey),
    }),
    groups: BACKUP_GROUPS,
    state: stateStore,
    notifier,
    dataDir: DATA_DIR,
  });
  return service;
}

// Runs one backup pass (scheduled, at startup, or on demand). Skipped with a
// log line until the backup channel and key are configured, so a fresh
// deployment isn't spammed with errors.
export async function runScheduledBackup() {
  if (!isBackupConfigured()) {
    console.log("[cloud-backup] DISCORD_BACKUP_CHANNEL / BACKUP_ENCRYPTION_KEY not set — skipping backup pass");
    return;
  }
  const results = await getBackupService().runAll();
  console.log("[cloud-backup] pass finished:", JSON.stringify(results));
}
