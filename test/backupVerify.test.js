import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { DatabaseSync } from "node:sqlite";
import { installChangeLog, maxLogId, readLogTail } from "../src/features/cloud-backup/changeLog.js";
import { snapshotTo, restoreInto, dataDigest, openDatabase, diffData } from "../src/features/cloud-backup/snapshot.js";
import { fingerprintFile, checkCloudCopyIntegrity, compareWithCloudCopy } from "../src/features/cloud-backup/verify.js";

const SCHEMA = `
  CREATE TABLE reminders (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, done INTEGER DEFAULT 0);
  CREATE TABLE grants (user_id TEXT NOT NULL, tier TEXT NOT NULL, PRIMARY KEY (user_id, tier));
`;

function makeWorkDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "backup-test-"));
}

// A live database shaped like the real ones: an autoincrement table and a
// composite-key table, with the change log installed.
function makeLiveDb(dir) {
  const db = new DatabaseSync(path.join(dir, "live.db"));
  db.exec(SCHEMA);
  installChangeLog(db);
  return db;
}

// Simulates one backup upload: the "cloud" copy plus the fingerprint
// recorded alongside it.
function uploadSnapshot(db, dir, name) {
  const cloudPath = path.join(dir, `${name}.cloud.db`);
  snapshotTo(db, cloudPath);
  return { cloudPath, recorded: fingerprintFile(cloudPath) };
}

function liveCopy(db, dir) {
  const livePath = path.join(dir, "live.copy.db");
  snapshotTo(db, livePath);
  return livePath;
}

test("triggers log inserts, updates and deletes with full row images", () => {
  const db = makeLiveDb(makeWorkDir());
  db.prepare(`INSERT INTO reminders (text) VALUES ('a')`).run();
  db.prepare(`UPDATE reminders SET text = 'b' WHERE id = 1`).run();
  db.prepare(`UPDATE reminders SET text = 'b' WHERE id = 1`).run(); // no-op: must not log
  db.prepare(`DELETE FROM reminders WHERE id = 1`).run();

  const log = readLogTail(db, 0);
  assert.deepEqual(log.map((e) => e.op), ["I", "U", "D"]);
  assert.deepEqual(JSON.parse(log[1].row), { id: 1, text: "b", done: 0 });
  assert.equal(log[2].row, null);
});

test("legitimate changes since the last snapshot verify cleanly and count as a change", () => {
  const dir = makeWorkDir();
  const db = makeLiveDb(dir);
  db.prepare(`INSERT INTO reminders (text) VALUES ('first')`).run();
  const { cloudPath } = uploadSnapshot(db, dir, "one");

  db.prepare(`INSERT INTO reminders (text) VALUES ('second')`).run();
  db.prepare(`UPDATE reminders SET done = 1 WHERE id = 1`).run();
  db.prepare(`INSERT INTO grants VALUES ('u1', 'personal')`).run();
  db.prepare(`DELETE FROM grants WHERE user_id = 'u1'`).run();

  const result = compareWithCloudCopy("live", liveCopy(db, dir), cloudPath, dir);
  assert.deepEqual(result.problems, []);
  assert.equal(result.changed, true);
});

test("no writes since the last snapshot means no change (no duplicate instance)", () => {
  const dir = makeWorkDir();
  const db = makeLiveDb(dir);
  db.prepare(`INSERT INTO reminders (text) VALUES ('x')`).run();
  const { cloudPath } = uploadSnapshot(db, dir, "one");

  const result = compareWithCloudCopy("live", liveCopy(db, dir), cloudPath, dir);
  assert.deepEqual(result.problems, []);
  assert.equal(result.changed, false);
});

test("a write that bypassed the log is reported as a host fault, with the differing row", () => {
  const dir = makeWorkDir();
  const db = makeLiveDb(dir);
  db.prepare(`INSERT INTO reminders (text) VALUES ('x')`).run();
  const { cloudPath } = uploadSnapshot(db, dir, "one");

  // Corruption / out-of-band edit: a write the triggers never saw.
  db.exec(`DROP TRIGGER changelog_reminders_au`);
  db.prepare(`UPDATE reminders SET text = 'tampered' WHERE id = 1`).run();

  const result = compareWithCloudCopy("live", liveCopy(db, dir), cloudPath, dir);
  assert.equal(result.problems.length, 1);
  assert.equal(result.problems[0].kind, "host");
  assert.equal(result.problems[0].diffs[0].a.text, "tampered");
  assert.equal(result.problems[0].diffs[0].b.text, "x");
});

test("a live log that no longer continues the cloud log is reported as a log fault", () => {
  const dir = makeWorkDir();
  const db = makeLiveDb(dir);
  db.prepare(`INSERT INTO reminders (text) VALUES ('x')`).run();
  db.prepare(`INSERT INTO reminders (text) VALUES ('y')`).run();
  const { cloudPath } = uploadSnapshot(db, dir, "one");

  db.exec(`DELETE FROM change_log WHERE id = 1`);

  const result = compareWithCloudCopy("live", liveCopy(db, dir), cloudPath, dir);
  assert.equal(result.problems[0].kind, "log");
});

test("a cloud copy that doesn't match its recorded fingerprint fails the integrity check", () => {
  const dir = makeWorkDir();
  const db = makeLiveDb(dir);
  db.prepare(`INSERT INTO reminders (text) VALUES ('x')`).run();
  const { cloudPath, recorded } = uploadSnapshot(db, dir, "one");
  assert.deepEqual(checkCloudCopyIntegrity("live", cloudPath, recorded), []);

  const tampered = openDatabase(cloudPath);
  tampered.exec(`UPDATE reminders SET text = 'edited in drive'`);
  tampered.close();
  assert.ok(checkCloudCopyIntegrity("live", cloudPath, recorded).length > 0);
  assert.ok(checkCloudCopyIntegrity("live", cloudPath, undefined).length > 0);
});

test("a schema migration since the snapshot is not mistaken for a fault", () => {
  const dir = makeWorkDir();
  const db = makeLiveDb(dir);
  db.prepare(`INSERT INTO reminders (text) VALUES ('old row')`).run();
  const { cloudPath } = uploadSnapshot(db, dir, "one");

  db.exec(`ALTER TABLE reminders ADD COLUMN flag INTEGER DEFAULT 5`);
  db.exec(`CREATE TABLE extras (k TEXT PRIMARY KEY, v TEXT)`);
  installChangeLog(db);
  db.prepare(`INSERT INTO extras VALUES ('a', 'b')`).run();
  db.prepare(`INSERT INTO reminders (text, flag) VALUES ('new row', 9)`).run();

  const result = compareWithCloudCopy("live", liveCopy(db, dir), cloudPath, dir);
  assert.deepEqual(result.problems, []);
  assert.equal(result.changed, true);
});

test("restoreInto replaces live data in place without logging the restore itself", () => {
  const dir = makeWorkDir();
  const db = makeLiveDb(dir);
  db.prepare(`INSERT INTO reminders (text) VALUES ('kept')`).run();
  const { cloudPath } = uploadSnapshot(db, dir, "one");
  const logBefore = maxLogId(db);

  db.prepare(`INSERT INTO reminders (text) VALUES ('lost')`).run();
  restoreInto(db, cloudPath);

  assert.deepEqual(db.prepare(`SELECT text FROM reminders`).all().map((r) => r.text), ["kept"]);
  assert.equal(maxLogId(db), logBefore);
  assert.equal(dataDigest(db), dataDigest(openDatabase(cloudPath)));

  // Triggers are back, and freshly issued ids continue after the restored ones.
  db.prepare(`INSERT INTO reminders (text) VALUES ('after')`).run();
  assert.equal(maxLogId(db), logBefore + 1);
  assert.equal(db.prepare(`SELECT MAX(id) AS id FROM reminders`).get().id, 2);
});

test("diffData reports rows only on one side and rows whose fields differ", () => {
  const dir = makeWorkDir();
  const a = makeLiveDb(dir);
  const b = new DatabaseSync(path.join(dir, "b.db"));
  b.exec(SCHEMA);
  a.prepare(`INSERT INTO reminders (text) VALUES ('same')`).run();
  b.prepare(`INSERT INTO reminders (text) VALUES ('same')`).run();
  a.prepare(`INSERT INTO reminders (text) VALUES ('only a')`).run();
  b.prepare(`INSERT INTO grants VALUES ('u', 'server')`).run();
  a.prepare(`UPDATE reminders SET done = 1 WHERE id = 1`).run();

  const diffs = diffData(a, b);
  assert.equal(diffs.length, 3);
  assert.ok(diffs.some((d) => d.table === "grants" && d.b && !d.a));
  assert.ok(diffs.some((d) => d.table === "reminders" && d.a && d.b));
  assert.ok(diffs.some((d) => d.table === "reminders" && d.a && !d.b));
});
