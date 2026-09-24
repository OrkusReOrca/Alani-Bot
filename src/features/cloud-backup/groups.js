// What gets backed up, and where it goes. Each group is one Drive folder with
// its own independent series of instances: a settings change never spawns a
// duplicate copy of the databases, and vice versa.

import { config } from "../../common/config.js";
import coreDb from "../db/store.js";
import orkusInfoDb from "../orkus-info/db.js";
import { settingsDb } from "../settings/store.js";

const rootPath = config.driveBackupRootPath.split("/").filter(Boolean);

export const BACKUP_GROUPS = [
  {
    id: "db",
    label: "DB Backup",
    folderPath: [...rootPath, "DB Backup"],
    databases: [
      { name: "db-core", db: coreDb },
      { name: "orkus-info", db: orkusInfoDb },
    ],
  },
  {
    id: "settings",
    label: "Settings",
    folderPath: [...rootPath, "Settings"],
    databases: [{ name: "settings", db: settingsDb }],
  },
];
