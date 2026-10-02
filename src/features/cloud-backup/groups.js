// What gets backed up. Each group is its own independent series of stored
// instances: a settings change never spawns a duplicate copy of the
// databases, and vice versa.

import coreDb from "../db/store.js";
import orkusInfoDb from "../orkus-info/db.js";
import { settingsDb } from "../settings/store.js";
import { historyDb } from "../ai-assistant/history.js";
import { voiceDb } from "../voice-player/stateStore.js";

export const BACKUP_GROUPS = [
  {
    id: "db",
    label: "DB Backup",
    databases: [
      { name: "db-core", db: coreDb },
      { name: "orkus-info", db: orkusInfoDb },
    ],
  },
  {
    id: "settings",
    label: "Settings",
    databases: [{ name: "settings", db: settingsDb }],
  },
  {
    id: "ai-history",
    label: "AIcommandHistory",
    databases: [{ name: "AIcommandHistory", db: historyDb }],
  },
  {
    id: "voice",
    label: "VoiceState",
    databases: [{ name: "VoiceState", db: voiceDb }],
  },
];
