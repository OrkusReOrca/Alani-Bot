// The bot's settings, kept in their own small SQLite database (backed up to
// Google Drive like the others — see features/cloud-backup/). Only keys
// declared in definitions.js exist; anything unset reads as its default, so
// a fresh install needs no seeding.

import { DatabaseSync } from "node:sqlite";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { installChangeLog } from "../cloud-backup/changeLog.js";
import { SETTING_DEFINITIONS } from "./definitions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "..", "..", "data", "settings");

fs.mkdirSync(DATA_DIR, { recursive: true });

export const settingsDb = new DatabaseSync(path.join(DATA_DIR, "settings.db"));

settingsDb.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`);
installChangeLog(settingsDb);

function definitionOf(key) {
  const definition = SETTING_DEFINITIONS[key];
  if (!definition) throw new Error(`Unknown setting "${key}"`);
  return definition;
}

export function getSetting(key) {
  const { default: fallback } = definitionOf(key);
  return settingsDb.prepare(`SELECT value FROM settings WHERE key = ?`).get(key)?.value ?? fallback;
}

export function setSetting(key, value) {
  const { allowed } = definitionOf(key);
  if (!allowed.includes(value)) throw new Error(`"${value}" isn't a valid value for ${key} (allowed: ${allowed.join(", ")})`);
  settingsDb
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .run(key, value, new Date().toISOString());
}

export function listSettings() {
  return Object.entries(SETTING_DEFINITIONS).map(([key, definition]) => ({
    key,
    value: getSetting(key),
    description: definition.description,
  }));
}
