import { test } from "node:test";
import assert from "node:assert/strict";
import { IDS } from "./helpers/trackerWorld.js";

process.env.DISCORD_OWNER_0 = IDS.botOwner;
const { makeWorld, NOW } = await import("./helpers/trackerWorld.js");
const { isDestructive } = await import("../src/features/tracker/command.js");

const BP = 'create type:"Bloodpressure tracker" me';
const SETTING_BP = 'setting "Bloodpressure tracker" recuring:daily at:T21:00 to:"Register today blood pressure" sent:dm';

// ---------- access ----------
test("everything needs the Tracker tag", async () => {
  const w = await makeWorld();
  const denied = await w.run(BP, { user: IDS.stranger });
  assert.match(denied.text, /needs the Tracker tag/);
  assert.equal(w.store.listTrackers("user", IDS.stranger).length, 0);
  assert.match((await w.run("la bp 120 80", { user: IDS.stranger })).text, /needs the Tracker tag/);

  assert.match((await w.run(BP)).text, /Created/); // a tagged user
  assert.match((await w.run(BP, { user: IDS.botOwner })).text, /Created/); // bot owners always have every tag — see tags/store.js
});

// ---------- create ----------
test("create: a blood pressure tracker for yourself, with the next-step command", async () => {
  const w = await makeWorld();
  const r = await w.run(BP);
  assert.match(r.text, /✅ Created \*\*Bloodpressure tracker\*\* for you \(Tracker › Health tracker › Bloodpressure tracker\)/);
  assert.ok(r.text.includes('.at setting "Bloodpressure tracker" recuring:daily at:T21:00 to:"Register today blood pressure" sent:dm'));
  assert.match(r.text, /\.at la bp 120 80/);
  const tracker = w.store.findByType("user", IDS.user, "bloodpressure");
  assert.deepEqual([tracker.ownerKind, tracker.ownerId, tracker.createdBy, tracker.enabled], ["user", IDS.user, IDS.user, true]);
});

test("create: a second blood pressure tracker for the same user is refused; me is the default", async () => {
  const w = await makeWorld();
  await w.run('create type:"Bloodpressure tracker"'); // no me/server: defaults to me
  assert.match((await w.run(BP)).text, /already a Bloodpressure tracker/);
  assert.equal(w.store.listTrackers("user", IDS.user).length, 1);
});

test("create: at a server; a user and a server can each have one; it needs a server", async () => {
  const w = await makeWorld();
  const inDm = await w.run('create type:"Bloodpressure tracker" server');
  assert.match(inDm.text, /run it inside the server/);

  const created = await w.run('create type:"Bloodpressure tracker" server', { guildId: IDS.guild });
  assert.match(created.text, /Created \*\*Bloodpressure tracker\*\* for this server/);
  assert.ok(created.text.includes('.at server setting "Bloodpressure tracker"'));
  assert.equal(w.store.findByType("guild", IDS.guild, "bloodpressure").createdBy, IDS.user);

  await w.run(BP, { guildId: IDS.guild }); // personal one, made while standing in the server
  assert.equal(w.store.findByType("user", IDS.user, "bloodpressure").ownerKind, "user");
  assert.match((await w.run('create type:"Bloodpressure tracker" server', { guildId: IDS.guild, user: IDS.friend })).text, /already a Bloodpressure tracker/); // one per server
  assert.equal((await w.run('create type:"Bloodpressure tracker" server', { guildId: IDS.otherGuild, user: IDS.friend })).text.includes("Created"), true); // another server is fine
});

test("create: only the smallest subsets — categories explain what to create instead", async () => {
  const w = await makeWorld();
  const health = await w.run('create type:"Health tracker" me');
  assert.match(health.text, /"Health tracker" is only a category/);
  assert.match(health.text, /`Bloodpressure tracker`, `Pill tracker`/);
  assert.match((await w.run('create type:"Routine tracker" me')).text, /`Activity tracker`/);
  const root = await w.run('create type:"Tracker" me');
  assert.match(root.text, /`Bloodpressure tracker`, `Pill tracker`, `Activity tracker`/);
  assert.match((await w.run('create type:"Sleep tracker" me')).text, /I don't know a tracker type "Sleep tracker"/);
  assert.match((await w.run("create me")).text, /Say what to create/);
  assert.equal(w.store.listTrackers("user", IDS.user).length, 0);
});

test("create: activity trackers need a name, can be many, and names are unique", async () => {
  const w = await makeWorld();
  assert.match((await w.run('create type:"Activity tracker" me')).text, /needs a name/);
  const first = await w.run('create type:"Activity tracker" name:"Fortnite karaoke weekly" server', { guildId: IDS.guild });
  assert.match(first.text, /Created \*\*Fortnite karaoke weekly\*\* for this server \(Tracker › Routine tracker › Activity tracker\)/);
  assert.match(first.text, /recuring:weekly friday,sunday at:T19:30/);
  await w.run('create type:"Activity tracker" name:"Gym" server', { guildId: IDS.guild });
  assert.match((await w.run('create type:"Activity tracker" name:"fortnite KARAOKE weekly" server', { guildId: IDS.guild })).text, /already a tracker called/);
  assert.equal(w.store.listTrackers("guild", IDS.guild).length, 2);
  assert.match((await w.run(`create type:"Activity tracker" name:"${"x".repeat(61)}" me`)).text, /under 60 characters/);
});

test("create: a pill tracker, and the type is understood in a few spellings", async () => {
  const w = await makeWorld();
  assert.match((await w.run('create type:"pill TRACKER" me')).text, /Created \*\*Pill tracker\*\*/);
  assert.match((await w.run('create type:bp me')).text, /Created \*\*Bloodpressure tracker\*\*/);
  assert.match((await w.run('create type:"Pill tracker" me')).text, /already a Pill tracker/);
});

// ---------- setting ----------
test("setting: your blood pressure example — daily at 21:00, DM", async () => {
  const w = await makeWorld();
  await w.run(BP);
  const r = await w.run(SETTING_BP);

  assert.match(r.text, /✅ Updated \*\*Bloodpressure tracker\*\*/);
  assert.match(r.text, /• When: every day at 21:00 \(GMT\+7\)/);
  assert.match(r.text, /• Message: "Register today blood pressure"/);
  assert.match(r.text, /• Sent to: DM/);
  assert.match(r.text, /• Next reminder: 11\/10\/2026 21:00/); // it's 19:00 on the 11th
  const settings = w.store.getSettings(w.store.findByType("user", IDS.user, "bloodpressure").id);
  assert.deepEqual(settings.spec, { recurring: "daily", words: [], at: "T21:00" });
  assert.equal(settings.tzMinutes, 420);
  assert.deepEqual(w.calls.primedTrackers, [1]); // the schedule starts from its NEXT occurrence
});

test("setting: your karaoke example — weekly Friday and Sunday, tagged friends, a channel", async () => {
  const w = await makeWorld();
  await w.run('create type:"Activity tracker" name:"Fortnite karaoke weekly" me');
  const r = await w.run(`setting "Fortnite karaoke weekly" recuring:weekly friday,sunday at:T19:30 to:"It's Karaoke Time!!!" tag:higgorca,david,sam sent:${IDS.channel}`);

  assert.match(r.text, /• When: every Sunday and Friday at 19:30 \(GMT\+7\)/);
  assert.match(r.text, /• Message: "It's Karaoke Time!!!"/);
  assert.match(r.text, new RegExp(`• Sent to: <#${IDS.channel}>`));
  assert.match(r.text, /• Next reminder: 11\/10\/2026 19:30/); // today is Sunday, and it's only 19:00
  assert.ok(!r.text.includes("<@"), "setting replies must not ping the tagged people");
  const settings = w.store.getSettings(w.store.findByName("user", IDS.user, "Fortnite karaoke weekly").id);
  assert.deepEqual(settings.tagIds, [IDS.user, "600000000000000006", "700000000000000007"]);
  assert.equal(settings.sentTo, IDS.channel);
});

test("setting: changing one thing keeps the rest; viewing shows the current setting", async () => {
  const w = await makeWorld();
  await w.run(BP);
  await w.run(SETTING_BP);

  await w.run('setting "Bloodpressure tracker" at:T22:30'); // only the time
  const afterTime = w.store.getSettings(1);
  assert.deepEqual(afterTime.spec, { recurring: "daily", words: [], at: "T22:30" });
  assert.equal(afterTime.message, "Register today blood pressure");

  await w.run('setting "Bloodpressure tracker" to:"New text" tz:GMT-5'); // only text and timezone
  const afterText = w.store.getSettings(1);
  assert.deepEqual([afterText.message, afterText.tzMinutes, afterText.spec.at], ["New text", -300, "T22:30"]);

  const view = await w.run('setting "Bloodpressure tracker"');
  assert.match(view.text, /• When: every day at 22:30 \(GMT-5\)/);
  assert.match(view.text, /Message: "New text"/);
});

test("setting: blood pressure is daily only; bad input is explained and changes nothing", async () => {
  const w = await makeWorld();
  await w.run(BP);
  assert.match((await w.run('setting "Bloodpressure tracker" recuring:weekly friday at:T21:00')).text, /Blood pressure is logged daily/);
  assert.match((await w.run('setting "Bloodpressure tracker" recuring:daily at:evening')).text, /end with a time/);
  assert.match((await w.run('setting "Bloodpressure tracker" tz:somewhere')).text, /`tz:` looks like `GMT\+7`/);
  assert.match((await w.run('setting "Bloodpressure tracker" tag:nobody')).text, /Couldn't find "nobody" to tag/);
  assert.match((await w.run('setting "Bloodpressure tracker" sent:12345')).text, /`sent:` is `dm` or a channel ID/);
  assert.match((await w.run('setting "Bloodpressure tracker" sent:400000000000000099')).text, /Can't send in channel/);
  assert.match((await w.run('setting "Bloodpressure tracker" colour:red')).text, /doesn't take `colour:`/);
  assert.match((await w.run('setting "No such tracker" at:T21:00')).text, /No tracker called "No such tracker"/);
  assert.match((await w.run("setting")).text, /Usage/);
  assert.equal(w.store.getSettings(1).spec, null);
});

test("setting: a daily reminder given only a time, with the weekdays etc. for the other kinds", async () => {
  const w = await makeWorld();
  await w.run('create type:"Activity tracker" name:"Bills" me');
  assert.match((await w.run('setting "Bills" recuring:monthly 1,15 at:T09:00 to:"Pay bills"')).text, /monthly on day 1 and day 15 at 09:00/);
  assert.match((await w.run('setting "Bills" recuring:yearly at:10,03,T09:00')).text, /every year on 03\/10 at 09:00/);
  assert.match((await w.run('setting "Bills" recuring:weekly at:T09:00')).text, /list the days/);
});

test("setting: a server tracker may only send to a channel of its own server", async () => {
  const w = await makeWorld();
  await w.run('create type:"Activity tracker" name:"Club night" server', { guildId: IDS.guild });
  const wrong = await w.run(`setting "Club night" recuring:daily at:T20:00 sent:${IDS.foreignChannel}`, { guildId: IDS.guild });
  assert.match(wrong.text, /only send to a channel of its own server/);
  assert.match((await w.run(`setting "Club night" recuring:daily at:T20:00 sent:${IDS.channel}`, { guildId: IDS.guild })).text, /Updated/);
});

test("the Pill tracker's setting takes only tz, tag and sent — schedules belong to each pill", async () => {
  const w = await makeWorld();
  await w.run('create type:"Pill tracker" me');
  const r = await w.run('setting "Pill tracker" recuring:daily at:T21:00');
  assert.match(r.text, /doesn't take `recurring:`, `at:`/);
  assert.match(r.text, /Pills get their schedule from `.at pill addpill`/);
  assert.match((await w.run('setting "Pill tracker" tz:GMT+7 sent:dm')).text, /Timezone: GMT\+7 \(each pill has its own schedule\)/);
});

// ---------- enable / disable ----------
test("disable and enable: turn the tracker off and on without deleting anything", async () => {
  const w = await makeWorld();
  await w.run(BP);
  await w.run("la bp 120 80");

  assert.match((await w.run('disable "Bloodpressure tracker" me')).text, /⏸ \*\*Bloodpressure tracker\*\* is off — no reminders and no new logs, but nothing was deleted/);
  assert.equal(w.store.getTracker(1).enabled, false);
  assert.match((await w.run("la bp 121 81")).text, /is disabled — turn it on with `.at enable "Bloodpressure tracker"`/);
  assert.equal(w.store.listBpLogs(1).length, 1); // nothing new, nothing lost
  assert.ok((await w.run("bp list")).pages, "viewing still works while it's off");

  assert.match((await w.run('enable "Bloodpressure tracker" me')).text, /is on again/);
  assert.match((await w.run("la bp 121 81")).text, /Logged/);
});

test("enable/disable find the tracker in the right place, ask when it's ambiguous, and respect access", async () => {
  const w = await makeWorld();
  await w.run(BP);
  await w.run(BP, { guildId: IDS.guild });
  await w.run('create type:"Bloodpressure tracker" server', { guildId: IDS.guild });

  assert.match((await w.run('disable "Bloodpressure tracker"', { guildId: IDS.guild })).text, /exists both for you and for this server — add `me` or `server`/);
  assert.match((await w.run('disable "Bloodpressure tracker" server', { guildId: IDS.guild })).text, /is off/);
  assert.equal(w.store.findByType("guild", IDS.guild, "bloodpressure").enabled, false);
  assert.equal(w.store.findByType("user", IDS.user, "bloodpressure").enabled, true);

  assert.match((await w.run('enable "Bloodpressure tracker" server', { guildId: IDS.guild, user: IDS.friend })).text, /don't have access/);
  assert.match((await w.run('enable "Nonexistent" me')).text, /No tracker called "Nonexistent"/);
  assert.match((await w.run("enable")).text, /Usage/);
});

// ---------- permissions ----------
test("permission: the owner can grant and revoke; a granted person reaches the personal tracker by the owner's ID", async () => {
  const w = await makeWorld();
  await w.run(BP);
  const asFriend = (line) => w.run(line, { user: IDS.friend });

  assert.match((await asFriend(`${IDS.user} la bp 120 80`)).text, /don't have access to that user's Bloodpressure tracker/);

  const granted = await w.run("permission grant friend");
  assert.match(granted.text, new RegExp(`✅ <@${IDS.friend}> can now add, log, edit and view your trackers`));
  assert.ok(!granted.text.includes("Tracker tag"), "the friend already has the Tracker tag");
  assert.match((await w.run("permission grant friend")).text, /already has permission/);

  assert.match((await asFriend(`${IDS.user} la bp 122 82`)).text, /Logged \*\*122\/82\*\*/);
  assert.equal(w.store.listBpLogs(1)[0].loggedBy, IDS.friend); // the log remembers who added it
  assert.ok((await asFriend(`${IDS.user} bp list`)).pages);
  assert.match((await asFriend("la bp 120 80")).text, /You don't have a Bloodpressure tracker yet/); // their own scope is separate

  assert.match((await w.run("permission revoke friend")).text, /Removed/);
  assert.match((await asFriend(`${IDS.user} la bp 120 80`)).text, /don't have access/);
  assert.match((await w.run("permission revoke friend")).text, /didn't have permission/);
});

test("permission: only the owner grants — not the person with permission, nor a stranger; bot owners always may", async () => {
  const w = await makeWorld();
  await w.run(BP);
  await w.run("permission grant friend");

  // Someone else acting on the owner's scope can't hand out more permission.
  assert.match((await w.run(`${IDS.user} permission grant sam`, { user: IDS.friend })).text, /Only the tracker's owner can change who has permission/);
  assert.match((await w.run(`${IDS.user} permission grant david`, { user: IDS.botOwner })).text, /can now add, log, edit and view that user's trackers/);
  assert.equal(w.store.hasGrant("user", IDS.user, "600000000000000006"), true);
});

test("permission: server trackers — only whoever created the server's trackers grants, and people without the Tracker tag are warned", async () => {
  const w = await makeWorld({ taggedUsers: [IDS.user, IDS.friend] });
  await w.run('create type:"Bloodpressure tracker" server', { guildId: IDS.guild });

  assert.match((await w.run("permission grant david server", { guildId: IDS.guild, user: IDS.friend })).text, /Only the people who created this server's trackers/);
  const granted = await w.run("permission grant david server", { guildId: IDS.guild });
  assert.match(granted.text, /can now add, log, edit and view this server's trackers/);
  assert.match(granted.text, /They'll also need the Tracker tag/); // david isn't tagged
  assert.match((await w.run("permission grant someone-unknown server", { guildId: IDS.guild })).text, /Couldn't find "someone-unknown"/);
  assert.match((await w.run("permission grant", { guildId: IDS.guild })).text, /Usage/);
  assert.match((await w.run("permission grant friend server")).text, /run it inside the server/); // in a DM
});

// ---------- blood pressure ----------
test("log a reading: the numbers with the date and time down to the minute, in the tracker's timezone", async () => {
  const w = await makeWorld({ now: Date.UTC(2026, 9, 11, 14, 3, 40) }); // 21:03 in GMT+7
  await w.run(BP);
  const r = await w.run("logadd bloodpressure 120 80");
  assert.match(r.text, /🩺 Logged \*\*120\/80\*\* at 11\/10\/2026 21:03\./);
  assert.match((await w.run("la bp 118 76")).text, /Logged \*\*118\/76\*\*/); // the short form
  assert.deepEqual(w.store.listBpLogs(1).map((l) => `${l.systolic}/${l.diastolic}`), ["118/76", "120/80"]); // two on one day is fine
  assert.equal(w.store.listBpLogs(1)[1].loggedAt, "2026-10-11T14:03:40.000Z");
});

test("log a reading: typos are caught, and so is a missing tracker", async () => {
  const w = await makeWorld();
  assert.match((await w.run("la bp 120 80")).text, /You don't have a Bloodpressure tracker yet — create it with `.at create type:"Bloodpressure tracker" me`/);
  await w.run(BP);
  assert.match((await w.run("la bp 80 120")).text, /systolic\) has to be higher than the second/);
  assert.match((await w.run("la bp 1200 80")).text, /between 30 and 300/);
  assert.match((await w.run("la bp 12 8")).text, /between 30 and 300/);
  assert.match((await w.run("la bp abc 80")).text, /whole numbers between 30 and 300/);
  assert.match((await w.run("la bp 120")).text, /Usage/);
  assert.match((await w.run("la sleep 8")).text, /Usage: `.at la bp 120 80` or `.at la p bpl,fl y`/);
  assert.equal(w.store.listBpLogs(1).length, 0);
});

test("the server's blood pressure tracker is separate, and others in the server can't read or write it without permission", async () => {
  const w = await makeWorld();
  await w.run('create type:"Bloodpressure tracker" server', { guildId: IDS.guild });
  await w.run(BP);

  assert.match((await w.run("server la bp 130 85", { guildId: IDS.guild })).text, /Logged \*\*130\/85\*\*/);
  assert.equal(w.store.listBpLogs(w.store.findByType("guild", IDS.guild, "bloodpressure").id).length, 1);
  assert.equal(w.store.listBpLogs(w.store.findByType("user", IDS.user, "bloodpressure").id).length, 0);

  const blocked = await w.run("server bp list", { guildId: IDS.guild, user: IDS.friend });
  assert.match(blocked.text, /don't have access to this server's Bloodpressure tracker — only its owner and people they've given permission to/);
  assert.equal(blocked.pages, null);
  assert.match((await w.run("server la bp 120 80", { guildId: IDS.guild, user: IDS.friend })).text, /don't have access/);

  await w.run("permission grant friend server", { guildId: IDS.guild });
  assert.ok((await w.run("server bp list", { guildId: IDS.guild, user: IDS.friend })).pages);
  assert.match((await w.run("server bp list")).text, /run it inside the server/); // "server" in a DM
});

test("bp list: pages with the newest first, in the tracker's timezone; empty gives a clear message", async () => {
  const w = await makeWorld();
  await w.run(BP);
  assert.equal((await w.run("bp list")).pages[0].description, "No readings logged yet.");

  const tracker = w.store.getTracker(1);
  for (let i = 0; i < 20; i++) w.store.addBpLog(tracker.id, 100 + i, 70, IDS.user, new Date(Date.UTC(2026, 9, 1 + i, 14, 5)));
  const r = await w.run("bp list");

  assert.equal(r.pages.length, 2); // 15 + 5
  assert.equal(r.pages[0].title, "Blood pressure · Bloodpressure tracker");
  assert.match(r.pages[0].description, /^\*\*#1\*\* · 20\/10\/2026 21:05 · \*\*119\/70\*\*/); // the newest on top (1 Oct + 19 days)
  assert.match(r.pages[1].description, /\*\*#20\*\* · 01\/10\/2026 21:05 · \*\*100\/70\*\*$/); // the oldest last
  assert.equal(r.pages[0].footer, "Page 1 / 2 · 20 readings · GMT+7");
  assert.match(r.pageOptions.detail, /^20\/10\/2026 21:05 119\/70\n/); // .aii sees the list too
  assert.ok((await w.run("bp ls")).pages && (await w.run("bp l")).pages);
});

test("bp export: latestX, oldestX, a date range and all — sent as a text file, oldest first", async () => {
  const w = await makeWorld({ now: Date.UTC(2026, 10, 14, 5, 30) });
  await w.run(BP);
  const tracker = w.store.getTracker(1);
  for (let i = 0; i < 20; i++) w.store.addBpLog(tracker.id, 100 + i, 70, IDS.user, new Date(Date.UTC(2026, 9, 1 + i, 14, 5))); // Oct 1..20

  const latest = await w.run("bp export latest3");
  assert.match(latest.text, /📄 Exported 3 readings \(the latest 3\)/);
  assert.equal(latest.files[0].name, "bloodpressure-20261114.txt");
  assert.equal(
    latest.files[0].text,
    [
      "Bloodpressure tracker — blood pressure log",
      "Exported 14/11/2026 12:30 (GMT+7) · 3 entries · the latest 3",
      "date time, systolic/diastolic",
      "",
      "18/10/2026 21:05  117/70",
      "19/10/2026 21:05  118/70",
      "20/10/2026 21:05  119/70",
      "",
    ].join("\n")
  );

  const oldest = await w.run("bp export oldest2");
  assert.deepEqual(oldest.files[0].text.split("\n").slice(4, 6), ["01/10/2026 21:05  100/70", "02/10/2026 21:05  101/70"]);

  const range = await w.run("bp export 2026/10/5-2026/10/7");
  assert.match(range.text, /Exported 3 readings \(2026\/10\/5 to 2026\/10\/7\)/);
  assert.deepEqual(range.files[0].text.split("\n").slice(4, 7), ["05/10/2026 21:05  104/70", "06/10/2026 21:05  105/70", "07/10/2026 21:05  106/70"]);

  assert.match((await w.run("bp export all")).text, /Exported 20 readings \(all logs\)/);
  assert.match((await w.run("bp export 2027/1/1-2027/1/31")).text, /No readings in 2027\/1\/1 to 2027\/1\/31/);
  assert.equal((await w.run("bp export 2027/1/1-2027/1/31")).files.length, 0);
  assert.match((await w.run("bp export yesterday")).text, /Use `latestX`, `oldestX`/);
  assert.match((await w.run("bp export")).text, /Usage: `.at bp export/);
});

test("bp delete: asks yes/no first, and only the chosen range goes", async () => {
  const w = await makeWorld();
  await w.run(BP);
  const tracker = w.store.getTracker(1);
  for (let i = 0; i < 6; i++) w.store.addBpLog(tracker.id, 110 + i, 70, IDS.user, new Date(Date.UTC(2026, 9, 1 + i, 14, 5)));

  const declined = await w.run("bp delete latest2", { confirmAnswer: false });
  assert.match(declined.confirmations[0], /Delete \*\*2 readings\*\* \(the latest 2, 05\/10\/2026 21:05 → 06\/10\/2026 21:05\) from Bloodpressure tracker\? This can't be undone\. Reply \*\*yes\*\* within 60 seconds/);
  assert.match(declined.text, /nothing was deleted/);
  assert.equal(w.store.listBpLogs(1).length, 6);

  const done = await w.run("bp delete latest2");
  assert.match(done.text, /🗑 Deleted 2 readings \(the latest 2\)/);
  assert.deepEqual(w.store.listBpLogs(1).map((l) => l.systolic), [113, 112, 111, 110]);

  await w.run("bp delete 2026/10/1-2026/10/2");
  assert.deepEqual(w.store.listBpLogs(1).map((l) => l.systolic), [113, 112]);
  await w.run("bp delete oldest1");
  assert.deepEqual(w.store.listBpLogs(1).map((l) => l.systolic), [113]);
  await w.run("bp delete all");
  assert.equal(w.store.listBpLogs(1).length, 0);
  assert.match((await w.run("bp delete all")).text, /No readings in all logs/);
  assert.equal((await w.run("bp delete all")).confirmations.length, 0); // nothing to delete: nothing to confirm
});

test("bp delete via .aii doesn't ask twice (the assistant already confirmed); an unusable context refuses", async () => {
  const w = await makeWorld();
  await w.run(BP);
  w.store.addBpLog(1, 120, 80, IDS.user);
  const viaAI = await w.run("bp delete all", { viaAI: true });
  assert.equal(viaAI.confirmations.length, 0);
  assert.match(viaAI.text, /Deleted 1 reading/);

  w.store.addBpLog(1, 120, 80, IDS.user);
  const ctx = { userId: IDS.user, channelId: "c", guildId: null, reply: async () => {} };
  const noConfirm = [];
  ctx.reply = async (t) => noConfirm.push(t);
  const { createExecute } = await import("../src/features/tracker/command.js");
  await createExecute(w.deps)(ctx, ["bp", "delete", "all"]);
  assert.match(noConfirm.join(), /nothing was deleted/);
  assert.equal(w.store.listBpLogs(1).length, 1);
});

test("which commands need a confirmation when .aii runs them", () => {
  assert.equal(isDestructive(["bp", "delete", "all"]), true);
  assert.equal(isDestructive(["server", "pill", "delete", "bpl", "all"]), true);
  assert.equal(isDestructive(["pill", "removepill", "bpl"]), true);
  assert.equal(isDestructive(["bp", "export", "all"]), false);
  assert.equal(isDestructive(["la", "bp", "120", "80"]), false);
});

// ---------- pills ----------
const PILL_TRACKER = 'create type:"Pill tracker" me';
const BPL = 'pill addpill "Bloodpressure lowerer"/"bpl" recuring:daily at:T21:00';
const FL = 'pill addpill "Fat lowerer"/"fl" recuring:daily at:T21:00';

test("addpill: your two examples, with alias, schedule and the next reminder", async () => {
  const w = await makeWorld();
  await w.run(PILL_TRACKER);
  const first = await w.run(BPL);
  assert.match(first.text, /💊 Added \*\*Bloodpressure lowerer\*\* \(alias `bpl`\) — every day at 21:00 \(GMT\+7\)\. Next reminder: 11\/10\/2026 21:00\./);
  assert.match((await w.run(FL)).text, /Added \*\*Fat lowerer\*\* \(alias `fl`\)/);
  assert.deepEqual(w.store.listPills(1).map((p) => [p.name, p.alias, p.spec.at]), [["Bloodpressure lowerer", "bpl", "T21:00"], ["Fat lowerer", "fl", "T21:00"]]);
  assert.deepEqual(w.calls.primedPills, [1, 2]);

  const list = await w.run("pill pills");
  assert.match(list.text, /• \*\*Bloodpressure lowerer\*\* \(`bpl`\) — every day at 21:00/);
  assert.match((await w.run("p pills")).text, /Fat lowerer/);
  assert.match((await w.run("pills")).text, /Fat lowerer/);
});

test("addpill: different pills can have different times and recurrence; errors are explained", async () => {
  const w = await makeWorld();
  await w.run(PILL_TRACKER);
  assert.match((await w.run('pill addpill "Vitamin D"/"vd" recuring:weekly monday,thursday at:T08:00')).text, /every Monday and Thursday at 08:00/);
  assert.match((await w.run('pill addpill "Check-up shot" recuring:monthly 1 at:T09:00')).text, /monthly on day 1 at 09:00/); // no alias
  assert.match((await w.run(BPL)).text, /Added/);
  assert.match((await w.run('pill addpill "Another"/"bpl" recuring:daily at:T09:00')).text, /already a pill called/);
  assert.match((await w.run('pill addpill "bloodpressure LOWERER" recuring:daily at:T09:00')).text, /already a pill called/);
  assert.match((await w.run('pill addpill "No schedule"')).text, /one of daily, weekly, monthly, yearly/);
  assert.match((await w.run("pill addpill")).text, /Usage: `.at pill addpill "Full name"\/"alias"/);
  assert.equal(w.store.listPills(1).length, 3);
});

test("addpill and logging need the tracker to exist, to be on, and to be yours", async () => {
  const w = await makeWorld();
  assert.match((await w.run(BPL)).text, /You don't have a Pill tracker yet/);
  await w.run(PILL_TRACKER);
  await w.run('disable "Pill tracker" me');
  assert.match((await w.run(BPL)).text, /is disabled/);
  await w.run('enable "Pill tracker" me');
  await w.run(BPL);
  assert.match((await w.run(BPL, { user: IDS.stranger })).text, /needs the Tracker tag/);
  assert.match((await w.run(`${IDS.user} ${BPL}`, { user: IDS.friend })).text, /don't have access/);
});

test("log pills: several at once by name or alias, taken or not", async () => {
  const w = await makeWorld({ now: Date.UTC(2026, 9, 11, 14, 5) });
  await w.run(PILL_TRACKER);
  await w.run(BPL);
  await w.run(FL);

  const both = await w.run("la p bpl,fl y");
  assert.match(both.text, /✅ Logged as taken: \*\*Bloodpressure lowerer\*\*, \*\*Fat lowerer\*\* \(11\/10\/2026 21:05\)\./);
  const quoted = await w.run('logadd pill "bloodpressure lowerer","fat lowerer" yes');
  assert.match(quoted.text, /Logged as taken/);
  const no = await w.run("la p fl n");
  assert.match(no.text, /📝 Logged as not taken: \*\*Fat lowerer\*\*/);
  assert.deepEqual(w.store.listPillLogs([1, 2]).map((l) => `${l.pillName}:${l.taken}:${l.source}`).sort(), [
    "Bloodpressure lowerer:true:command",
    "Bloodpressure lowerer:true:command",
    "Fat lowerer:false:command",
    "Fat lowerer:true:command",
    "Fat lowerer:true:command",
  ]);

  assert.match((await w.run("la p nope y")).text, /No pill "nope" in Pill tracker/);
  assert.match((await w.run("la p bpl maybe")).text, /Usage: `.at la p <pill>,<pill> yes\|no`/);
  assert.match((await w.run("la p y")).text, /Usage/);
  assert.equal(w.store.listPillLogs([1, 2]).length, 5); // the failures logged nothing
});

test("pill list / export / delete per pill, with the same ranges as blood pressure", async () => {
  const w = await makeWorld({ now: Date.UTC(2026, 10, 1, 5, 0) });
  await w.run(PILL_TRACKER);
  await w.run(BPL);
  await w.run(FL);
  for (let i = 0; i < 4; i++) {
    w.store.addPillLog(1, i % 2 === 0, IDS.user, "command", new Date(Date.UTC(2026, 9, 1 + i, 14, 5)));
    w.store.addPillLog(2, true, IDS.user, "reply", new Date(Date.UTC(2026, 9, 1 + i, 14, 6)));
  }

  const one = await w.run("p list bpl");
  assert.equal(one.pages[0].title, "Pills · Pill tracker · Bloodpressure lowerer");
  assert.match(one.pages[0].description, /^\*\*#1\*\* · 04\/10\/2026 21:05 · Bloodpressure lowerer · ❌ not taken\n/);
  assert.equal(one.pages[0].description.split("\n").length, 4);
  assert.match((await w.run("p list")).pages[0].footer, /8 logs/); // all pills

  const exported = await w.run("p export bpl latest2");
  assert.equal(exported.files[0].name, "pills-20261101.txt");
  assert.deepEqual(exported.files[0].text.split("\n").slice(0, 2), ["Pill tracker — pill log", "Exported 01/11/2026 12:00 (GMT+7) · 2 entries · the latest 2"]);
  assert.deepEqual(exported.files[0].text.split("\n").slice(4, 6), ["03/10/2026 21:05  Bloodpressure lowerer  yes", "04/10/2026 21:05  Bloodpressure lowerer  no"]);
  assert.equal((await w.run("p export all")).files[0].text.includes("Fat lowerer  yes"), true); // no pill named: all of them

  const declined = await w.run("p delete bpl all", { confirmAnswer: false });
  assert.match(declined.confirmations[0], /Delete \*\*4 logs\*\* \(all logs, .*\) from Pill tracker\?/);
  assert.equal(w.store.listPillLogs([1]).length, 4);
  assert.match((await w.run("p delete bpl latest1")).text, /Deleted 1 log/);
  assert.equal(w.store.listPillLogs([1]).length, 3);
  assert.equal(w.store.listPillLogs([2]).length, 4); // the other pill is untouched

  assert.match((await w.run("p delete all")).text, /Name the pill whose logs to delete/); // "all" alone: which pill?
  assert.match((await w.run("p delete")).text, /Usage/);
  assert.match((await w.run("p list nope")).text, /No pill "nope"/);
});

test("removepill: confirms, then removes the pill and its logs", async () => {
  const w = await makeWorld();
  await w.run(PILL_TRACKER);
  await w.run(BPL);
  w.store.addPillLog(1, true, IDS.user, "command");

  const declined = await w.run("pill removepill bpl", { confirmAnswer: false });
  assert.match(declined.confirmations[0], /Remove \*\*Bloodpressure lowerer\*\* and all its logs from Pill tracker\?/);
  assert.equal(w.store.listPills(1).length, 1);

  const done = await w.run('pill removepill "Bloodpressure lowerer"');
  assert.match(done.text, /🗑 Removed \*\*Bloodpressure lowerer\*\* and its logs/);
  assert.equal(w.store.listPills(1).length, 0);
  assert.deepEqual(w.calls.forgottenPills, [1]);
  assert.match((await w.run("pill removepill bpl")).text, /No pill "bpl"/);
});

// ---------- list & help ----------
test("`.at list` shows your trackers and this server's, with their schedules", async () => {
  const w = await makeWorld();
  assert.match((await w.run("list")).text, /\*\*Your trackers\*\*\nnone/);

  await w.run(BP);
  await w.run(SETTING_BP);
  await w.run(PILL_TRACKER);
  await w.run(BPL);
  await w.run('create type:"Activity tracker" name:"Gym" server', { guildId: IDS.guild });
  await w.run('server setting "Gym" recuring:weekly monday at:T18:00', { guildId: IDS.guild });
  await w.run('disable "Pill tracker" me');

  const r = await w.run("list", { guildId: IDS.guild });
  assert.match(r.text, /• \*\*Bloodpressure tracker\*\* \(Bloodpressure tracker\) — on · every day at 21:00/);
  assert.match(r.text, /• \*\*Pill tracker\*\* \(Pill tracker\) — off · 1 pill/);
  assert.match(r.text, /\*\*This server's trackers\*\*\n• \*\*Gym\*\* \(Activity tracker\) — on · every Monday at 18:00/);
  assert.ok(!(await w.run("list", { guildId: IDS.guild, user: IDS.friend })).text.includes("Gym")); // no access, not shown
});

test("unknown input shows the usage", async () => {
  const w = await makeWorld();
  for (const line of ["", "dance", "bp", "pill", "bp frobnicate"]) {
    const text = (await w.run(line)).text;
    assert.match(text, /Usage|Trackers|Create/i, `"${line}" should explain itself`);
  }
  assert.match((await w.run("")).text, /\*\*Trackers\*\*/);
  assert.ok(NOW > 0);
});

// ---------- help ----------
test("help and type list are open to everyone and list every command / type", async () => {
  const w = await makeWorld();
  const help = await w.run("help", { user: IDS.stranger }); // no Tracker tag needed to read the docs
  assert.match(help.text, /\.at create type:/);
  assert.match(help.text, /\.at la bp 120 80/);
  assert.match(help.text, /addpill/);

  const types = await w.run("type list", { user: IDS.stranger });
  for (const name of ["Bloodpressure tracker", "Pill tracker", "Activity tracker", "Health tracker", "Routine tracker"]) assert.ok(types.text.includes(name), name);
  assert.equal((await w.run("type", { user: IDS.stranger })).text, types.text);
  assert.equal(w.store.listTrackers("user", IDS.stranger).length, 0); // read-only
});
