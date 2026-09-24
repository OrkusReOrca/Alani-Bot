// Prints a fresh random encryption key for the cloud backup.
//
//   npm run backup-key
//
// Put the value in BACKUP_ENCRYPTION_KEY on the host AND keep a copy somewhere
// safe (a password manager): without it the backups can't be decrypted, and
// generating a new one makes every existing backup unreadable.

import { generateKeyHex } from "../src/features/cloud-backup/crypto.js";

console.log(`BACKUP_ENCRYPTION_KEY=${generateKeyHex()}`);
