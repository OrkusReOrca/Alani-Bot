import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createTrackerStore, TrackerError } from "../src/features/tracker/storeFactory.js";
import { maxLogId, listDataTables } from "../src/features/cloud-backup/changeLog.js";

const make = () => createTrackerStore(new DatabaseSync(":memory:"));
const bp = (store, extra = {}) => store.createTracker({ type: "bloodpressure", name: "Bloodpressure tracker", ownerKind: "user", ownerId: "u1", createdBy: "u1", ...extra });

test("one tracker file holds every kind of tracker's settings and data (so the backup is a single file)", () => {
  const store = make();
  const db = new DatabaseSync(":memory:");
  createTrackerStore(db);
  assert.deepEqual(listDataTables(db), ["bp_logs", "pill_logs", "pills", "tracker_permissions", "tracker_settings", "trackers"]);
  assert.ok(store);
});

test("a user and a server can each have one blood pressure tracker, but not two", () => {
  const store = make();
  const mine = bp(store);
  const servers = bp(store, { ownerKind: "guild", ownerId: "g1" });
  assert.notEqual(mine.id, servers.id);
  assert.throws(() => bp(store, { name: "Another one" }), (err) => err instanceof TrackerError && /already a Bloodpressure tracker/.test(err.message));
  assert.throws(() => bp(store, { ownerKind: "guild", ownerId: "g1", name: "Second" }), TrackerError);
  assert.equal(store.findByType("user", "u1", "bloodpressure").id, mine.id);
  assert.equal(store.findByType("guild", "g1", "bloodpressure").id, servers.id);
});

test("pill trackers are one per owner too; activity trackers can be many but names are unique per owner, ignoring case", () => {
  const store = make();
  store.createTracker({ type: "pill", name: "Pill tracker", ownerKind: "user", ownerId: "u1", createdBy: "u1" });
  assert.throws(() => store.createTracker({ type: "pill", name: "Pills 2", ownerKind: "user", ownerId: "u1", createdBy: "u1" }), TrackerError);

  const activity = (name, ownerId = "u1") => store.createTracker({ type: "activity", name, ownerKind: "user", ownerId, createdBy: ownerId });
  activity("Fortnite karaoke weekly");
  activity("Gym");
  assert.throws(() => activity("FORTNITE karaoke WEEKLY"), (err) => /already a tracker called/.test(err.message));
  activity("Gym", "u2"); // another owner may reuse the name
  assert.equal(store.listTrackers("user", "u1").length, 3);
  assert.equal(store.findByName("user", "u1", "gym").name, "Gym");
  assert.throws(() => store.createTracker({ type: "nonsense", name: "x", ownerKind: "user", ownerId: "u1", createdBy: "u1" }), /Unknown tracker type/);
});

test("enabling, disabling, and who created what", () => {
  const store = make();
  const tracker = bp(store, { ownerKind: "guild", ownerId: "g1", createdBy: "creator" });
  assert.equal(tracker.enabled, true);
  store.setEnabled(tracker.id, false);
  assert.equal(store.getTracker(tracker.id).enabled, false);
  assert.deepEqual(store.listEnabledTrackers(), []);
  store.setEnabled(tracker.id, true);
  assert.equal(store.listEnabledTrackers().length, 1);
  assert.equal(store.createdAnyFor("guild", "g1", "creator"), true);
  assert.equal(store.createdAnyFor("guild", "g1", "someone"), false);
});

test("settings default to GMT+7 and DM, and round-trip", () => {
  const store = make();
  const tracker = bp(store);
  assert.deepEqual(store.getSettings(tracker.id), { spec: null, tzMinutes: 420, message: null, tagIds: [], sentTo: "dm" });

  const settings = { spec: { recurring: "daily", words: [], at: "T21:00" }, tzMinutes: -300, message: "Register it", tagIds: ["a", "b"], sentTo: "123456789012345678" };
  store.saveSettings(tracker.id, settings);
  assert.deepEqual(store.getSettings(tracker.id), settings);
  store.saveSettings(tracker.id, { ...settings, tagIds: [] });
  assert.deepEqual(store.getSettings(tracker.id).tagIds, []);
});

test("permissions are per owner, can be granted once, and revoked", () => {
  const store = make();
  assert.equal(store.grant("user", "u1", "friend", "u1"), true);
  assert.equal(store.grant("user", "u1", "friend", "u1"), false); // already had it
  assert.equal(store.hasGrant("user", "u1", "friend"), true);
  assert.equal(store.hasGrant("guild", "u1", "friend"), false); // a different owner kind
  assert.deepEqual(store.listGrants("user", "u1"), ["friend"]);
  assert.equal(store.revoke("user", "u1", "friend"), true);
  assert.equal(store.revoke("user", "u1", "friend"), false);
  assert.equal(store.hasGrant("user", "u1", "friend"), false);
});

test("blood pressure logs come back newest first, and can be checked per time window and deleted", () => {
  const store = make();
  const tracker = bp(store);
  store.addBpLog(tracker.id, 118, 78, "u1", new Date("2026-10-10T14:00:00Z"));
  store.addBpLog(tracker.id, 120, 80, "u1", new Date("2026-10-11T14:03:00Z"));
  store.addBpLog(tracker.id, 125, 82, "friend", new Date("2026-10-09T14:00:00Z"));

  const logs = store.listBpLogs(tracker.id);
  assert.deepEqual(logs.map((l) => `${l.systolic}/${l.diastolic}`), ["120/80", "118/78", "125/82"]);
  assert.equal(logs[2].loggedBy, "friend");

  const day = (iso) => [Date.parse(`${iso}T00:00:00Z`), Date.parse(`${iso}T00:00:00Z`) + 86400000];
  assert.equal(store.hasBpLogBetween(tracker.id, ...day("2026-10-11")), true);
  assert.equal(store.hasBpLogBetween(tracker.id, ...day("2026-10-12")), false);

  assert.equal(store.deleteBpLogs([logs[0].id, logs[1].id]), 2);
  assert.equal(store.listBpLogs(tracker.id).length, 1);
  assert.equal(store.deleteBpLogs([]), 0);
});

test("pills: found by name or alias ignoring case, unique within a tracker, removed together with their logs", () => {
  const store = make();
  const tracker = store.createTracker({ type: "pill", name: "Pill tracker", ownerKind: "user", ownerId: "u1", createdBy: "u1" });
  const spec = { recurring: "daily", words: [], at: "T21:00" };
  const bpl = store.addPill(tracker.id, { name: "Bloodpressure lowerer", alias: "bpl", spec });
  store.addPill(tracker.id, { name: "Fat lowerer", alias: "fl", spec });

  assert.equal(store.findPill(tracker.id, "BPL").id, bpl.id);
  assert.equal(store.findPill(tracker.id, "bloodpressure LOWERER").id, bpl.id);
  assert.equal(store.findPill(tracker.id, "nope"), null);
  assert.throws(() => store.addPill(tracker.id, { name: "Other", alias: "bpl", spec }), TrackerError); // alias taken
  assert.throws(() => store.addPill(tracker.id, { name: "fat LOWERER", alias: null, spec }), TrackerError); // name taken
  assert.deepEqual(store.listPills(tracker.id).map((p) => p.name), ["Bloodpressure lowerer", "Fat lowerer"]);

  store.addPillLog(bpl.id, true, "u1", "command", new Date("2026-10-11T14:00:00Z"));
  store.addPillLog(bpl.id, false, "u1", "reply", new Date("2026-10-12T14:00:00Z"));
  const logs = store.listPillLogs([bpl.id]);
  assert.deepEqual(logs.map((l) => [l.taken, l.source, l.pillName]), [[false, "reply", "Bloodpressure lowerer"], [true, "command", "Bloodpressure lowerer"]]);
  assert.equal(store.wasPillTakenBetween(bpl.id, Date.parse("2026-10-11T00:00:00Z"), Date.parse("2026-10-12T00:00:00Z")), true);
  assert.equal(store.wasPillTakenBetween(bpl.id, Date.parse("2026-10-12T00:00:00Z"), Date.parse("2026-10-13T00:00:00Z")), false); // that one was "no"

  assert.equal(store.removePill(bpl.id), true);
  assert.equal(store.listPillLogs([bpl.id]).length, 0);
  assert.equal(store.getPill(bpl.id), null);
});

test("every write is recorded in the change log, so the tracker file passes the cloud backup's checks", () => {
  const db = new DatabaseSync(":memory:");
  const store = createTrackerStore(db);
  const before = maxLogId(db);
  const tracker = bp(store);
  store.addBpLog(tracker.id, 120, 80, "u1");
  store.saveSettings(tracker.id, { spec: null, tzMinutes: 420, message: "x", tagIds: [], sentTo: "dm" });
  assert.equal(maxLogId(db), before + 3);
});
