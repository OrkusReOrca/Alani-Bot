import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { DatabaseSync } from "node:sqlite";
import { createTrackerStore } from "../src/features/tracker/storeFactory.js";
import { createReminderState } from "../src/features/tracker/reminderState.js";
import { createReminderEngine, LATE_LIMIT_MS } from "../src/features/tracker/reminders.js";
import { handlePillReply } from "../src/features/tracker/pillReply.js";
import { awaitConfirmation } from "../src/common/confirm.js";

const OWNER = "200000000000000002";
const FRIEND = "300000000000000003";
const CHANNEL = "400000000000000004";
const GUILD = "900000000000000009";
const GMT7 = 420;
const at = (day, h, m = 0) => Date.UTC(2026, 9, day, h, m) - GMT7 * 60000; // October 2026, wall-clock GMT+7 (the 11th is a Sunday)

const DAILY_2100 = { recurring: "daily", words: [], at: "T21:00" };

function setup(now) {
  const store = createTrackerStore(new DatabaseSync(":memory:"));
  const state = createReminderState(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "reminder-test-")), "state.json"));
  const sent = { dm: [], channel: [] };
  const clock = { now };
  const delivery = {
    dm: async (userId, text) => sent.dm.push({ userId, text }),
    channel: async (channelId, text) => sent.channel.push({ channelId, text }),
  };
  const engine = createReminderEngine({ store, state, delivery, now: () => clock.now, log: { error: () => {} } });
  const tick = async (time) => {
    clock.now = time;
    await engine.tick();
  };
  const tracker = (type, name, settings = {}, owner = { kind: "user", id: OWNER, by: OWNER }) => {
    const created = store.createTracker({ type, name, ownerKind: owner.kind, ownerId: owner.id, createdBy: owner.by });
    store.saveSettings(created.id, { spec: null, tzMinutes: GMT7, message: null, tagIds: [], sentTo: "dm", ...settings });
    return created;
  };
  return { store, state, sent, clock, engine, tick, tracker };
}

const bpSettings = (extra = {}) => ({ spec: DAILY_2100, message: "Register today blood pressure", ...extra });

// ---------- blood pressure ----------
test("blood pressure: the reminder goes out at the set time, once, and again the next day", async () => {
  const w = setup(at(11, 20, 0));
  w.tracker("bloodpressure", "Bloodpressure tracker", bpSettings());

  await w.tick(at(11, 20, 59));
  assert.deepEqual(w.sent.dm, []);
  await w.tick(at(11, 21, 0));
  assert.deepEqual(w.sent.dm, [{ userId: OWNER, text: "Register today blood pressure" }]);
  await w.tick(at(11, 21, 0) + 30_000);
  await w.tick(at(11, 21, 5));
  assert.equal(w.sent.dm.length, 1); // still just the one
  await w.tick(at(12, 21, 0));
  assert.equal(w.sent.dm.length, 2);
});

test("blood pressure: if today's reading is already logged, no reminder — whenever in the day it was logged", async () => {
  const w = setup(at(11, 8, 0));
  const tracker = w.tracker("bloodpressure", "Bloodpressure tracker", bpSettings());
  w.store.addBpLog(tracker.id, 120, 80, OWNER, new Date(at(11, 7, 45))); // this morning (GMT+7)

  await w.tick(at(11, 21, 0));
  assert.deepEqual(w.sent.dm, []);
  await w.tick(at(12, 21, 0)); // but tomorrow, with nothing logged, it reminds again
  assert.equal(w.sent.dm.length, 1);
});

test("blood pressure: only TODAY counts — yesterday's reading doesn't silence today, and midnight in the tracker's timezone is the boundary", async () => {
  const w = setup(at(11, 8, 0));
  const tracker = w.tracker("bloodpressure", "Bloodpressure tracker", bpSettings());
  w.store.addBpLog(tracker.id, 120, 80, OWNER, new Date(at(10, 23, 59))); // 23:59 the day before
  await w.tick(at(11, 21, 0));
  assert.equal(w.sent.dm.length, 1);

  w.store.addBpLog(tracker.id, 120, 80, OWNER, new Date(at(12, 0, 1))); // just after midnight: that's the 12th
  await w.tick(at(12, 21, 0));
  assert.equal(w.sent.dm.length, 1); // skipped
});

test("a skipped reminder isn't sent later either (deleting the log afterwards doesn't bring it back)", async () => {
  const w = setup(at(11, 8, 0));
  const tracker = w.tracker("bloodpressure", "Bloodpressure tracker", bpSettings());
  w.store.addBpLog(tracker.id, 120, 80, OWNER, new Date(at(11, 9, 0)));
  await w.tick(at(11, 21, 0));
  w.store.deleteBpLogs(w.store.listBpLogs(tracker.id).map((l) => l.id));
  await w.tick(at(11, 21, 10));
  assert.deepEqual(w.sent.dm, []);
});

test("after downtime a reminder up to an hour late is still sent, older ones are not", async () => {
  assert.equal(LATE_LIMIT_MS, 60 * 60 * 1000);
  const late = setup(at(11, 20, 0));
  late.tracker("bloodpressure", "Bloodpressure tracker", bpSettings());
  await late.tick(at(11, 21, 40)); // the bot came back 40 minutes late
  assert.equal(late.sent.dm.length, 1);

  const tooLate = setup(at(11, 20, 0));
  tooLate.tracker("bloodpressure", "Bloodpressure tracker", bpSettings());
  await tooLate.tick(at(11, 22, 30));
  assert.deepEqual(tooLate.sent.dm, []);
});

test("a schedule just set starts from its NEXT occurrence, not an hour-old one", async () => {
  const w = setup(at(11, 21, 30));
  const tracker = w.tracker("bloodpressure", "Bloodpressure tracker", bpSettings());
  w.engine.primeTracker(tracker); // what `.at setting` does
  await w.tick(at(11, 21, 31));
  assert.deepEqual(w.sent.dm, []);
  await w.tick(at(12, 21, 0));
  assert.equal(w.sent.dm.length, 1);
});

test("disabled trackers and trackers with no schedule send nothing", async () => {
  const w = setup(at(11, 20, 0));
  const off = w.tracker("bloodpressure", "Bloodpressure tracker", bpSettings());
  w.store.setEnabled(off.id, false);
  w.tracker("activity", "Unscheduled", { spec: null });
  await w.tick(at(11, 21, 0));
  assert.deepEqual(w.sent.dm, []);
});

test("a tracker with the default message says so by name", async () => {
  const w = setup(at(11, 17, 0));
  w.tracker("activity", "Gym", { spec: { recurring: "daily", words: [], at: "T18:00" }, message: null });
  await w.tick(at(11, 18, 0));
  assert.equal(w.sent.dm[0].text, "Time for Gym!");
});

// ---------- activity: tags, channels, schedules ----------
const KARAOKE = { spec: { recurring: "weekly", words: ["friday,sunday"], at: "T19:30" }, message: "It's Karaoke Time!!!" };

test("activity in a channel: the message with the tagged people (and the owner of a personal tracker) mentioned", async () => {
  const w = setup(at(11, 19, 0));
  w.tracker("activity", "Fortnite karaoke weekly", { ...KARAOKE, tagIds: ["600000000000000006", "700000000000000007"], sentTo: CHANNEL });
  await w.tick(at(11, 19, 30));
  assert.deepEqual(w.sent.dm, []);
  assert.deepEqual(w.sent.channel, [{ channelId: CHANNEL, text: `It's Karaoke Time!!! <@600000000000000006> <@700000000000000007> <@${OWNER}>` }]);
});

test("activity by DM: the owner and every tagged person each get their own DM", async () => {
  const w = setup(at(11, 19, 0));
  w.tracker("activity", "Karaoke", { ...KARAOKE, tagIds: [FRIEND, OWNER] });
  await w.tick(at(11, 19, 30));
  assert.deepEqual(w.sent.dm.map((d) => d.userId), [OWNER, FRIEND]); // the owner once, even though also tagged
});

test("weekly Friday and Sunday: fires on those days only", async () => {
  const w = setup(at(11, 19, 0));
  w.tracker("activity", "Karaoke", KARAOKE);
  for (const [day, expected] of [[11, 1], [12, 1], [13, 1], [16, 2], [17, 2]]) {
    await w.tick(at(day, 19, 30));
    assert.equal(w.sent.dm.length, expected, `day ${day}`); // Sun 11 fires, Mon 12 / Tue 13 don't, Fri 16 does
  }
});

test("a server's tracker DMs whoever created it", async () => {
  const w = setup(at(11, 19, 0));
  w.tracker("activity", "Club night", { spec: { recurring: "daily", words: [], at: "T19:30" }, message: "Club night!" }, { kind: "guild", id: GUILD, by: FRIEND });
  await w.tick(at(11, 19, 30));
  assert.deepEqual(w.sent.dm, [{ userId: FRIEND, text: "Club night!" }]);
});

test("one tracker failing doesn't stop the others", async () => {
  const w = setup(at(11, 19, 0));
  w.tracker("activity", "Broken", { ...KARAOKE, sentTo: CHANNEL });
  w.tracker("activity", "Fine", { spec: { recurring: "daily", words: [], at: "T19:30" }, message: "ok" });
  const failing = createReminderEngine({
    store: w.store,
    state: w.state,
    now: () => w.clock.now,
    log: { error: () => {} },
    delivery: { dm: async (userId, text) => w.sent.dm.push({ userId, text }), channel: async () => Promise.reject(new Error("Missing Access")) },
  });
  w.clock.now = at(11, 19, 30);
  await failing.tick();
  assert.deepEqual(w.sent.dm, [{ userId: OWNER, text: "ok" }]);
});

test("a DM that can't be delivered to one person still reaches the others", async () => {
  const w = setup(at(11, 19, 0));
  w.tracker("activity", "Karaoke", { ...KARAOKE, tagIds: [FRIEND] });
  const engine = createReminderEngine({
    store: w.store,
    state: w.state,
    now: () => w.clock.now,
    log: { error: () => {} },
    delivery: { dm: async (userId, text) => (userId === OWNER ? Promise.reject(new Error("Cannot send messages to this user")) : w.sent.dm.push({ userId, text })), channel: async () => {} },
  });
  w.clock.now = at(11, 19, 30);
  await engine.tick();
  assert.deepEqual(w.sent.dm.map((d) => d.userId), [FRIEND]);
});

// ---------- pills ----------
function pillSetup(now = at(11, 20, 0), settings = {}) {
  const w = setup(now);
  const tracker = w.tracker("pill", "Pill tracker", settings);
  const addPill = (name, alias, spec = DAILY_2100) => w.store.addPill(tracker.id, { name, alias, spec });
  return { ...w, trackerRow: tracker, addPill };
}

test("pills due at the same time make ONE reminder naming all of them, and wait for a yes/no in the DM", async () => {
  const w = pillSetup();
  const bpl = w.addPill("Bloodpressure lowerer", "bpl");
  const fl = w.addPill("Fat lowerer", "fl");

  await w.tick(at(11, 21, 0));
  assert.equal(w.sent.dm.length, 1);
  assert.deepEqual(w.sent.dm[0], { userId: OWNER, text: '💊 Reminder to take pills "Bloodpressure lowerer, Fat lowerer" — have you taken them yet? Reply **yes** or **no**.' });
  assert.deepEqual(w.state.takePending(OWNER, at(11, 21, 1)), { trackerId: w.trackerRow.id, pillIds: [bpl.id, fl.id], expiresAt: at(11, 21, 0) + 12 * 3600 * 1000 });
});

test("a pill already logged as taken that day is left out; if all are taken there's no reminder at all", async () => {
  const w = pillSetup();
  const bpl = w.addPill("Bloodpressure lowerer", "bpl");
  w.addPill("Fat lowerer", "fl");
  w.store.addPillLog(bpl.id, true, OWNER, "command", new Date(at(11, 18, 0)));

  await w.tick(at(11, 21, 0));
  assert.equal(w.sent.dm[0].text, '💊 Reminder to take pill "Fat lowerer" — have you taken it yet? Reply **yes** or **no**.');

  const all = pillSetup();
  const only = all.addPill("Vitamin", "v");
  all.store.addPillLog(only.id, true, OWNER, "command", new Date(at(11, 8, 0)));
  await all.tick(at(11, 21, 0));
  assert.deepEqual(all.sent.dm, []);
  assert.equal(all.state.hasPending(OWNER, at(11, 21, 1)), false);
});

test("logging 'no' doesn't silence the reminder — only 'taken' does", async () => {
  const w = pillSetup();
  const pill = w.addPill("Vitamin", "v");
  w.store.addPillLog(pill.id, false, OWNER, "command", new Date(at(11, 8, 0)));
  await w.tick(at(11, 21, 0));
  assert.equal(w.sent.dm.length, 1);
});

test("pills at different times, or on different days, remind separately", async () => {
  const w = pillSetup(at(11, 7, 0));
  w.addPill("Morning pill", "am", { recurring: "daily", words: [], at: "T08:00" });
  w.addPill("Night pill", "pm", DAILY_2100);
  w.addPill("Monday pill", "mon", { recurring: "weekly", words: ["monday"], at: "T21:00" });

  await w.tick(at(11, 8, 0));
  await w.tick(at(11, 21, 0));
  assert.deepEqual(w.sent.dm.map((d) => d.text.match(/"(.*)"/)[1]), ["Morning pill", "Night pill"]); // Sunday: no Monday pill
  await w.tick(at(12, 21, 0));
  assert.deepEqual(w.sent.dm.slice(2).map((d) => d.text.match(/"(.*)"/)[1]), ["Night pill, Monday pill"]); // Monday evening: both, in one message
});

test("pill reminders sent to a channel say how to log, and don't wait for a DM reply", async () => {
  const w = pillSetup(at(11, 20, 0), { sentTo: CHANNEL, tagIds: [FRIEND] });
  w.addPill("Vitamin", "v");
  await w.tick(at(11, 21, 0));
  assert.deepEqual(w.sent.channel, [{ channelId: CHANNEL, text: `💊 Reminder to take pill "Vitamin" — have you taken it yet? Log it with \`.at la p <pill> y\`. <@${FRIEND}> <@${OWNER}>` }]);
  assert.equal(w.state.hasPending(OWNER, at(11, 21, 1)), false);
});

test("a pill added just now doesn't fire for a time that already passed", async () => {
  const w = pillSetup(at(11, 21, 30));
  const pill = w.addPill("Vitamin", "v");
  w.engine.primePill(pill);
  await w.tick(at(11, 21, 31));
  assert.deepEqual(w.sent.dm, []);
  await w.tick(at(12, 21, 0));
  assert.equal(w.sent.dm.length, 1);
});

// ---------- the yes/no reply in a DM ----------
const dm = (content, userId = OWNER) => {
  const replies = [];
  return { content, guildId: null, channelId: "dmchannel", author: { id: userId }, reply: async (payload) => replies.push(payload.content), replies };
};

async function remindedWorld() {
  const w = pillSetup();
  const bpl = w.addPill("Bloodpressure lowerer", "bpl");
  const fl = w.addPill("Fat lowerer", "fl");
  await w.tick(at(11, 21, 0));
  const reply = (message, now = at(11, 21, 5)) => handlePillReply(message, { state: w.state, store: w.store, now: () => now });
  return { ...w, bpl, fl, reply };
}

test("'yes' or 'y' right after the reminder logs every pill it asked about as taken, with no command", async () => {
  for (const word of ["yes", "Y", "  yes  "]) {
    const w = await remindedWorld();
    const message = dm(word);
    assert.equal(await w.reply(message), true);
    assert.deepEqual(message.replies, ["✅ Logged **Bloodpressure lowerer**, **Fat lowerer** as taken."]);
    assert.deepEqual(w.store.listPillLogs([w.bpl.id, w.fl.id]).map((l) => [l.pillName, l.taken, l.source, l.loggedBy]).sort(), [
      ["Bloodpressure lowerer", true, "reply", OWNER],
      ["Fat lowerer", true, "reply", OWNER],
    ]);
  }
});

test("'no' or 'n' logs them as not taken, and the next 'yes' isn't treated as an answer", async () => {
  const w = await remindedWorld();
  const message = dm("n");
  assert.equal(await w.reply(message), true);
  assert.match(message.replies[0], /📝 Logged \*\*Bloodpressure lowerer\*\*, \*\*Fat lowerer\*\* as not taken/);
  assert.deepEqual(w.store.listPillLogs([w.bpl.id]).map((l) => l.taken), [false]);
  assert.equal(await w.reply(dm("yes")), false); // the question was answered; a stray "yes" does nothing
  assert.equal(w.store.listPillLogs([w.bpl.id, w.fl.id]).length, 2);
});

test("after a 'yes' the pills aren't reminded about again that day", async () => {
  const w = await remindedWorld();
  await w.reply(dm("yes"));
  w.sent.dm.length = 0;
  await w.tick(at(11, 21, 40));
  await w.tick(at(12, 20, 0));
  assert.deepEqual(w.sent.dm, []);
  await w.tick(at(12, 21, 0)); // tomorrow's cycle
  assert.equal(w.sent.dm.length, 1);
});

test("other messages are left alone and keep the question open", async () => {
  const w = await remindedWorld();
  for (const text of ["maybe", "yes please", "what", "t bp list", ".a info"]) assert.equal(await w.reply(dm(text)), false, text);
  assert.equal(await w.reply(dm("yes")), true); // still answerable
});

test("a reply only counts in a DM, only from the person asked, and only while the question is fresh", async () => {
  const w = await remindedWorld();
  const inServer = { ...dm("yes"), guildId: "900000000000000009" };
  assert.equal(await w.reply(inServer), false);
  assert.equal(await w.reply(dm("yes", FRIEND)), false); // someone else
  assert.equal(await w.reply(dm("yes"), at(12, 21, 5)), false); // a day later: the question expired
  assert.equal(w.store.listPillLogs([w.bpl.id, w.fl.id]).length, 0);
  assert.equal(await handlePillReply(dm("yes"), { state: w.state, store: w.store, now: () => at(11, 21, 5) }), false); // expiry cleared it
});

test("a newer reminder replaces an unanswered older one", async () => {
  const w = pillSetup(at(11, 7, 0));
  const am = w.addPill("Morning pill", "am", { recurring: "daily", words: [], at: "T08:00" });
  const pm = w.addPill("Night pill", "pm", DAILY_2100);
  await w.tick(at(11, 8, 0));
  await w.tick(at(11, 21, 0)); // the morning question was never answered
  const message = dm("y");
  await handlePillReply(message, { state: w.state, store: w.store, now: () => at(11, 21, 5) });
  assert.deepEqual(w.store.listPillLogs([am.id]).length, 0);
  assert.deepEqual(w.store.listPillLogs([pm.id]).map((l) => l.taken), [true]);
});

test("a pill removed since the reminder is skipped; if none are left the reply isn't an answer", async () => {
  const w = await remindedWorld();
  w.store.removePill(w.bpl.id);
  const message = dm("yes");
  assert.equal(await w.reply(message), true);
  assert.deepEqual(message.replies, ["✅ Logged **Fat lowerer** as taken."]);

  const gone = await remindedWorld();
  gone.store.removePill(gone.bpl.id);
  gone.store.removePill(gone.fl.id);
  assert.equal(await gone.reply(dm("yes")), false);
});

test("while the bot is waiting for a different yes/no (an .aii or delete confirmation), the pill handler stays out of it", async () => {
  const w = await remindedWorld();
  let answer;
  const waiting = awaitConfirmation(
    { author: { id: OWNER }, channelId: "dmchannel", reply: async () => {}, channel: { awaitMessages: () => new Promise((resolve) => (answer = resolve)) } },
    "Delete?"
  );
  assert.equal(await w.reply(dm("yes")), false); // belongs to the confirmation
  assert.equal(w.store.listPillLogs([w.bpl.id, w.fl.id]).length, 0);

  answer({ first: () => ({ content: "yes" }) });
  assert.equal(await waiting, true);
  assert.equal(await w.reply(dm("yes")), true); // question over: the pill question is still waiting
});

// ---------- the state file ----------
test("reminder state survives a restart: what fired, and the waiting question", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "reminder-state-")), "state.json");
  const first = createReminderState(file);
  first.markFired("tracker:1", 12345);
  first.setPending(OWNER, { trackerId: 1, pillIds: [1, 2] }, 1000);

  const second = createReminderState(file);
  assert.equal(second.firedAt("tracker:1"), 12345);
  assert.equal(second.firedAt("tracker:99"), 0);
  assert.equal(second.hasPending(OWNER, 2000), true);
  assert.deepEqual(second.takePending(OWNER, 2000).pillIds, [1, 2]);
  assert.equal(second.takePending(OWNER, 2000), null);

  second.forget("tracker:1");
  assert.equal(createReminderState(file).firedAt("tracker:1"), 0);
  fs.writeFileSync(file, "not json"); // a damaged file must not crash anything
  assert.equal(createReminderState(file).firedAt("tracker:1"), 0);
});
