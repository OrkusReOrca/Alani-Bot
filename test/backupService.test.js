import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { DatabaseSync } from "node:sqlite";
import { installChangeLog } from "../src/features/cloud-backup/changeLog.js";
import { createBackupService } from "../src/features/cloud-backup/service.js";
import { createStateStore } from "../src/features/cloud-backup/state.js";
import { createFakeDrive } from "./helpers/fakeDrive.js";

const ROOT = ["Alani"];

function makeDb(dir, name) {
  const db = new DatabaseSync(path.join(dir, `${name}.db`));
  db.exec(`CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL)`);
  installChangeLog(db);
  return db;
}

const texts = (db) => db.prepare(`SELECT text FROM items ORDER BY id`).all().map((r) => r.text);

async function setup({ keepInstances = 16 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backup-service-test-"));
  const drive = createFakeDrive();
  await drive.seedFolders([...ROOT, "DB Backup"]);
  await drive.seedFolders([...ROOT, "Settings"]);

  const dbA = makeDb(dir, "alpha");
  const dbB = makeDb(dir, "beta");
  const settingsDb = makeDb(dir, "prefs");
  const groups = [
    { id: "db", label: "DB Backup", folderPath: [...ROOT, "DB Backup"], databases: [{ name: "alpha", db: dbA }, { name: "beta", db: dbB }] },
    { id: "settings", label: "Settings", folderPath: [...ROOT, "Settings"], databases: [{ name: "prefs", db: settingsDb }] },
  ];

  const events = [];
  const notifier = {
    cloudUpdated: async (group) => events.push(`updated:${group.id}`),
    fault: async (group, report) => events.push(`fault:${group.id}`) && (notifier.lastReport = report),
    faultStillPending: async (group) => events.push(`pending:${group.id}`),
  };
  const state = createStateStore(path.join(dir, "state.json"));
  const service = createBackupService({ drive, groups, state, notifier, dataDir: dir, keepInstances });
  const outcomes = async () => Object.fromEntries((await service.runAll()).map((r) => [r.groupId, r.outcome]));
  const instances = (label) => drive.folderNames([...ROOT, label]);

  return { drive, dbA, dbB, settingsDb, service, events, state, outcomes, instances, notifier };
}

test("first pass uploads a baseline; an untouched second pass uploads nothing", async () => {
  const t = await setup();
  t.dbA.prepare(`INSERT INTO items (text) VALUES ('one')`).run();

  assert.deepEqual(await t.outcomes(), { db: "baseline", settings: "baseline" });
  assert.deepEqual(await t.outcomes(), { db: "unchanged", settings: "unchanged" });
  assert.equal((await t.instances("DB Backup")).length, 1);
});

test("a change creates a new instance only for the group it belongs to", async () => {
  const t = await setup();
  await t.service.runAll();

  t.settingsDb.prepare(`INSERT INTO items (text) VALUES ('toggle')`).run();
  assert.deepEqual(await t.outcomes(), { db: "unchanged", settings: "uploaded" });
  assert.equal((await t.instances("DB Backup")).length, 1);
  assert.equal((await t.instances("Settings")).length, 2);
});

test("only the newest 16 instances are kept, oldest dropped first", async () => {
  const t = await setup({ keepInstances: 16 });
  for (let i = 0; i < 20; i++) {
    t.dbA.prepare(`INSERT INTO items (text) VALUES (?)`).run(`row ${i}`);
    await t.service.runAll();
  }
  const names = await t.instances("DB Backup");
  assert.equal(names.length, 16);
  assert.match(names[0], /^instance_00005__/);
  assert.match(names.at(-1), /^instance_00020__/);
});

test("a fault uploads the host copy as FAULTY_, resets the host, pauses the group, then 'drive' discards the faulty copy", async () => {
  const t = await setup();
  t.dbA.prepare(`INSERT INTO items (text) VALUES ('good')`).run();
  await t.service.runAll();

  // Host data changes with no log entry explaining it.
  t.dbA.exec(`DROP TRIGGER changelog_items_ai`);
  t.dbA.prepare(`INSERT INTO items (text) VALUES ('phantom')`).run();
  installChangeLog(t.dbA);

  assert.equal((await t.outcomes()).db, "fault");
  assert.ok((await t.instances("DB Backup")).some((n) => n.startsWith("FAULTY_")));
  assert.deepEqual(texts(t.dbA), ["good"]); // host reset to the cloud version
  assert.match(t.notifier.lastReport, /phantom/);
  assert.ok(t.events.includes("fault:db"));

  // Paused: nothing new is uploaded while the fault is unresolved.
  assert.equal((await t.outcomes()).db, "pending-fault");
  assert.equal((await t.instances("DB Backup")).length, 2); // 1 instance + the FAULTY_ folder

  assert.match(await t.service.resolveFault("db", "drive"), /cloud version/);
  assert.equal((await t.instances("DB Backup")).length, 1);
  assert.equal(t.state.pending("db"), null);
  assert.deepEqual(texts(t.dbA), ["good"]);
  assert.equal((await t.outcomes()).db, "unchanged");
});

test("resolving a fault with 'host' restores the faulty data and saves it as the newest instance", async () => {
  const t = await setup();
  t.dbA.prepare(`INSERT INTO items (text) VALUES ('good')`).run();
  await t.service.runAll();

  t.dbA.exec(`DROP TRIGGER changelog_items_ai`);
  t.dbA.prepare(`INSERT INTO items (text) VALUES ('phantom')`).run();
  installChangeLog(t.dbA);
  await t.service.runAll();

  assert.match(await t.service.resolveFault("db", "host"), /host's version/);
  assert.deepEqual(texts(t.dbA), ["good", "phantom"]);
  const names = await t.instances("DB Backup");
  assert.equal(names.length, 2);
  assert.match(names.at(-1), /^instance_00002__/);
  assert.equal((await t.outcomes()).db, "unchanged"); // the new latest matches the host, log included
});

test("a tampered cloud copy is a fault; the host is reset to the newest INTACT instance", async () => {
  const t = await setup();
  t.dbA.prepare(`INSERT INTO items (text) VALUES ('v1')`).run();
  await t.service.runAll();
  t.dbA.prepare(`INSERT INTO items (text) VALUES ('v2')`).run();
  await t.service.runAll();

  const newest = await t.drive.findFile([...ROOT, "DB Backup"], (await t.instances("DB Backup")).at(-1), "alpha.db");
  t.drive.overwrite(newest.id, Buffer.from("garbage"));

  assert.equal((await t.outcomes()).db, "fault");
  assert.deepEqual(texts(t.dbA), ["v1"]); // instance 1 was the last intact one
  assert.match(t.state.pending("db").restoredFrom, /^instance_00001__/);
});

test("an incomplete instance (no meta.json) is cleaned up, not trusted", async () => {
  const t = await setup();
  await t.service.runAll();
  const folder = await t.drive.resolveFolderPath([...ROOT, "DB Backup"]);
  await t.drive.createFolder(folder, "instance_00002__2099-01-01T00-00-00Z");

  assert.equal((await t.outcomes()).db, "unchanged");
  assert.equal((await t.instances("DB Backup")).length, 1);
});

test("a Drive error in one group is reported for it and doesn't stop the others", async () => {
  const t = await setup();
  await t.drive.deleteItem(await t.drive.resolveFolderPath([...ROOT, "Settings"]));

  const results = await t.service.runAll();
  assert.equal(results.find((r) => r.groupId === "db").outcome, "baseline");
  assert.equal(results.find((r) => r.groupId === "settings").outcome, "error");
});

test("resolveFault with nothing pending says so", async () => {
  const t = await setup();
  assert.match(await t.service.resolveFault("db", "drive"), /No unresolved/);
});
