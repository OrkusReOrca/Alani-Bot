// Client-side encryption of backup files, so the place they're stored (a
// Discord channel) only ever holds opaque bytes.
//
// A backup file is gzip-compressed, then encrypted with AES-256-GCM:
//
//   "ALB1" | 12-byte nonce | 16-byte auth tag | ciphertext
//
// GCM is authenticated: any change to the file, a wrong key, or a file moved
// under a different name fails to decrypt (CorruptBackupError) instead of
// yielding garbage. `context` (group / instance name / file name) is bound
// into the tag for exactly that reason — an old backup can't be replayed as a
// newer one.

import crypto from "crypto";
import zlib from "zlib";

const MAGIC = Buffer.from("ALB1");
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const HEADER_BYTES = MAGIC.length + NONCE_BYTES + TAG_BYTES;

// The stored file failed to authenticate or is malformed: corrupted, edited,
// or encrypted with a different key.
export class CorruptBackupError extends Error {}

export function generateKeyHex() {
  return crypto.randomBytes(KEY_BYTES).toString("hex");
}

// 64 hex characters -> 32-byte key.
export function parseKey(hex) {
  if (!/^[0-9a-fA-F]{64}$/.test(hex ?? "")) {
    throw new Error("BACKUP_ENCRYPTION_KEY must be 64 hex characters (generate one with `npm run backup-key`)");
  }
  return Buffer.from(hex, "hex");
}

export function encryptBackup(plain, key, context) {
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(zlib.gzipSync(plain)), cipher.final()]);
  return Buffer.concat([MAGIC, nonce, cipher.getAuthTag(), ciphertext]);
}

export function decryptBackup(blob, key, context) {
  if (blob.length < HEADER_BYTES || !blob.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new CorruptBackupError("not a backup file (bad header)");
  }
  const nonce = blob.subarray(MAGIC.length, MAGIC.length + NONCE_BYTES);
  const tag = blob.subarray(MAGIC.length + NONCE_BYTES, HEADER_BYTES);
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(tag);
    return zlib.gunzipSync(Buffer.concat([decipher.update(blob.subarray(HEADER_BYTES)), decipher.final()]));
  } catch {
    throw new CorruptBackupError("failed to decrypt (corrupted, edited, or wrong key)");
  }
}
