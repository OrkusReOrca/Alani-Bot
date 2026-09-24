import { test } from "node:test";
import assert from "node:assert/strict";
import { encryptBackup, decryptBackup, generateKeyHex, parseKey, CorruptBackupError } from "../src/features/cloud-backup/crypto.js";

const key = parseKey(generateKeyHex());
const plain = Buffer.from("SQLite format 3 — pretend database bytes ".repeat(200));

test("a backup round-trips, and the stored bytes contain nothing readable", () => {
  const blob = encryptBackup(plain, key, "db/instance_00001/db-core.db");
  assert.deepEqual(decryptBackup(blob, key, "db/instance_00001/db-core.db"), plain);
  assert.equal(blob.includes(Buffer.from("SQLite")), false);
  assert.ok(blob.length < plain.length, "compressed before encrypting");
});

test("encrypting the same data twice gives different bytes (fresh nonce each time)", () => {
  assert.notDeepEqual(encryptBackup(plain, key, "ctx"), encryptBackup(plain, key, "ctx"));
});

test("a wrong key, edited bytes, or a different context all fail as CorruptBackupError", () => {
  const blob = encryptBackup(plain, key, "db/a/file.db");

  assert.throws(() => decryptBackup(blob, parseKey(generateKeyHex()), "db/a/file.db"), CorruptBackupError);
  assert.throws(() => decryptBackup(blob, key, "db/b/file.db"), CorruptBackupError); // moved under another name

  const edited = Buffer.from(blob);
  edited[edited.length - 1] ^= 0xff;
  assert.throws(() => decryptBackup(edited, key, "db/a/file.db"), CorruptBackupError);

  assert.throws(() => decryptBackup(Buffer.from("garbage"), key, "db/a/file.db"), CorruptBackupError);
});

test("keys must be exactly 64 hex characters", () => {
  assert.throws(() => parseKey("abc"), /64 hex/);
  assert.throws(() => parseKey(undefined), /64 hex/);
  assert.equal(parseKey(generateKeyHex()).length, 32);
});
