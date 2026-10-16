import { test, after } from "node:test";
import assert from "node:assert/strict";
import { startFakeAccountService, ACCOUNT_ID, LINKED_DISCORD_ID, SECRET } from "./helpers/fakeAccountService.js";

// the bot reads its account-service address from the environment, so the fake service starts first
const service = await startFakeAccountService();
process.env.ALATOMY_ACCOUNT_API_URL = service.url;
process.env.ALATOMY_ACCOUNT_API_SECRET = SECRET;
process.env.DISCORD_OWNER_0 = "999999999999999999";
after(() => service.close());

const { execute: dbExecute, isDestructive } = await import("../src/features/db/command.js");
const { execute: accountExecute } = await import("../src/features/alatomy-account/command.js");
const { execute: listExecute } = await import("../src/features/db/listDbCommand.js");
const { createAccountClient, AccountApiError } = await import("../src/features/alatomy-account/client.js");
const { createAccountReminderScheduler } = await import("../src/features/alatomy-account/scheduler.js");
const { accountClient } = await import("../src/features/alatomy-account/client.js");
const { setClient } = await import("../src/common/discordClient.js");
const { createExecute: createStatsExecute, formatStats } = await import("../src/features/alatomy-account/statsCommand.js");

const STRANGER = "222222222222222222";
const makeCtx = (userId = LINKED_DISCORD_ID, extra = {}) => {
  const replies = [];
  return { replies, userId, channelId: "555555555555555555", guildId: null, reply: async (text) => replies.push(text), get text() { return replies.join("\n"); }, ...extra };
};
const db = async (userId, ...args) => {
  const ctx = makeCtx(userId);
  await dbExecute(ctx, args.flatMap((a) => (a.includes(" ") && !a.startsWith('"') && !a.startsWith("2026") && !a.startsWith("T") ? a.split(" ") : [a])));
  return ctx.text;
};
const run = async (line, userId = LINKED_DISCORD_ID) => {
  const ctx = makeCtx(userId);
  await dbExecute(ctx, line.split(/\s+/));
  return ctx.text;
};

// ------------------------------------------------------------------------------- the client

test("the client looks accounts up with the bot secret, and caches the answer briefly", async () => {
  service.state.calls.length = 0;
  let now = 0;
  const client = createAccountClient({ apiUrl: service.url, apiSecret: SECRET, clock: () => now });
  assert.equal(client.isConfigured(), true);
  const first = await client.lookup(LINKED_DISCORD_ID);
  assert.equal(first.account.username, "ada");
  await client.lookup(LINKED_DISCORD_ID);
  assert.equal(service.state.calls.filter((c) => c.includes("/lookup")).length, 1);
  now = 61_000;
  await client.lookup(LINKED_DISCORD_ID);
  assert.equal(service.state.calls.filter((c) => c.includes("/lookup")).length, 2);

  assert.equal(await client.lookup(STRANGER), null);
  await client.lookup(STRANGER);
  assert.equal(service.state.calls.filter((c) => c.includes("/lookup")).length, 3); // "not linked" is cached too, for a shorter time
  now += 16_000;
  await client.lookup(STRANGER);
  assert.equal(service.state.calls.filter((c) => c.includes("/lookup")).length, 4);
});

test("the client turns outages and a wrong secret into clear errors", async () => {
  const wrongSecret = createAccountClient({ apiUrl: service.url, apiSecret: "nope" });
  await assert.rejects(wrongSecret.lookup(LINKED_DISCORD_ID), (e) => e instanceof AccountApiError && /isn't set up to talk/.test(e.message));
  const nobody = createAccountClient({ apiUrl: "http://127.0.0.1:1", apiSecret: SECRET });
  await assert.rejects(nobody.lookup(LINKED_DISCORD_ID), (e) => e instanceof AccountApiError && /isn't answering/.test(e.message));
  service.state.failWith = 500;
  await assert.rejects(createAccountClient({ apiUrl: service.url, apiSecret: SECRET }).lookup("1"), /had a problem/);
  service.state.failWith = null;
  assert.equal(createAccountClient({ apiUrl: null, apiSecret: null }).isConfigured(), false);
});

// ---------------------------------------------------------------------------- `.a db alatomy`

test("reminders: add, list, duplicate, force, edit, delete one, delete all", async () => {
  service.state.reminders = [];
  const added = await run('alatomy add reminder 2026-10-16T19:00 "call mum"');
  assert.match(added, /^Added reminder #1: "call mum" at 19:00 2026\/10\/16 \(will DM you\)$/);
  assert.match(await run('alatomy add reminder 2026-10-16T12:00 "earlier"'), /^Added reminder #2:/);
  assert.equal(service.state.reminders[0].remindAt, "2026-10-16T12:00:00.000Z"); // Bangkok time becomes UTC for the service

  const listed = await run("alatomy list reminders");
  assert.match(listed, /#1 — 19:00 2026\/10\/16 — call mum \(DM\)/);
  assert.match(listed, /#2 — .* — earlier \(DM\)/);

  assert.match(await run('alatomy add reminder 2026-10-16T19:30 "CALL  mum"'), /^Already have a similar reminder — #1 "call mum" at 19:00 2026\/10\/16 — not adding a duplicate\. Add `force`/);
  assert.match(await run('alatomy add reminder 2026-10-16T19:30 "call mum" force'), /^Added reminder #3:/);

  assert.match(await run('alatomy edit reminder 3 2026-10-17T08:00 "call dad"'), /^Updated reminder #3: "call dad" at 08:00 2026\/10\/17$/);
  assert.equal(await run('alatomy edit reminder 99 2026-10-17T08:00 "x"'), "No reminder #99.");
  assert.equal(await run("alatomy delete reminder 3"), "Deleted reminder #3.");
  assert.equal(await run("alatomy delete reminder 3"), "No reminder #3.");
  assert.equal(await run("alatomy delete reminder all"), "Deleted all 2 reminder(s).");
  assert.equal(await run("alatomy delete reminder all"), "No reminders to delete.");
  assert.equal(await run("alatomy list reminders"), "No reminders.");
});

test("reminders: mentions by id are passed on; unknown usernames are refused before anything is saved", async () => {
  service.state.reminders = [];
  const ok = await run('alatomy add reminder 2026-10-16T19:00 "standup" 333333333333333333,444444444444444444');
  assert.match(ok, /will also tag <@333333333333333333>, <@444444444444444444>|will also tag /);
  assert.deepEqual(service.state.reminders[0].mentions, ["333333333333333333", "444444444444444444"]);
  const refused = await run('alatomy add reminder 2026-10-16T19:00 "standup 2" somebody');
  assert.match(refused, /Couldn't resolve "somebody" to a Discord user \(no server context available/);
  assert.equal(service.state.reminders.length, 1);
});

test("reminders: a channel must be one the bot can post in; then it is stored and shown", async () => {
  service.state.reminders = [];
  setClient({ channels: { fetch: async (id) => (id === "777777777777777777" ? { isTextBased: () => true, guildId: null } : Promise.reject(new Error("unknown channel"))) }, user: { id: "bot" } });
  assert.match(await run('alatomy add reminder 2026-10-16T19:00 "x" 888888888888888888'), /Can't send in channel `888888888888888888`/);
  assert.equal(service.state.reminders.length, 0);
  const ok = await run('alatomy add reminder 2026-10-16T19:00 "post here" 777777777777777777');
  assert.match(ok, /will post in <#777777777777777777>/);
  assert.match(await run("alatomy list reminders"), /\(<#777777777777777777>\)/);
});

test("events: add with default length, overlap warning, all-day, duplicate, list, edit, delete", async () => {
  service.state.events = [];
  assert.match(await run('alatomy add event 2026-10-16T09:00 "Standup"'), /^Added event #1: "Standup" from 09:00 2026\/10\/16 to 10:00 2026\/10\/16$/);
  const clash = await run('alatomy add event 2026-10-16T09:30 2026-10-16T10:30 "Dentist" | Clinic');
  assert.match(clash, /^Added event #2: "Dentist" from 09:30 2026\/10\/16 to 10:30 2026\/10\/16\n⚠️ Overlaps with: "Standup" \(09:00 2026\/10\/16 - 10:00 2026\/10\/16\)$/);
  assert.equal(service.state.events[1].location, "Clinic");
  assert.match(await run('alatomy add event 2026-10-20T00:00 allday "Holiday"'), /^Added event #3: "Holiday" all day 2026\/10\/20$/);
  assert.match(await run('alatomy add event 2026-10-16T09:10 "standup"'), /^Already have a similar event — #1 "Standup"/);

  const listed = (await run("alatomy list events")).split("\n");
  assert.equal(listed.length, 3);
  assert.match(listed[0], /^#1 — 09:00 2026\/10\/16 to 10:00 2026\/10\/16 — Standup$/);
  assert.match(listed[2], /^#3 — 2026\/10\/20 \(all day\) — Holiday$/);

  assert.match(await run('alatomy edit event 1 2026-10-16T11:00 2026-10-16T12:00 "Standup (moved)"'), /^Updated event #1: "Standup \(moved\)" from 11:00 2026\/10\/16 to 12:00 2026\/10\/16$/);
  assert.equal(await run("alatomy delete event 2"), "Deleted event #2.");
  assert.equal(await run("alatomy delete event 2"), "No event #2.");
});

test("wrong arguments get the same usage text as the other databases", async () => {
  assert.match(await run("alatomy add reminder soon"), /^Usage: `\.a db \[<name>\] add reminder/);
  assert.match(await run("alatomy add event"), /^Usage: `\.a db add event/);
  assert.equal(await run("alatomy add stuff"), "Usage: `.a db add <reminder|event> ...`");
  assert.equal(await run("alatomy list stuff"), "Usage: `.a db list <reminders|events>`");
  assert.equal(await run("alatomy delete reminder"), "Usage: `.a db delete reminder <id|all>`");
  assert.match(await run("alatomy"), /^Usage: `\.a db \[<database>\]/); // no verb at all
});

test("people without a linked account, and outages, get clear answers", async () => {
  assert.match(await run("alatomy list reminders", STRANGER), /isn't linked to an Alatomy account yet.*https:\/\/alatomy\.com\/account\/login/s);
  service.state.failWith = 500;
  accountClient.forget(LINKED_DISCORD_ID);
  assert.match(await run("alatomy list reminders"), /had a problem/);
  service.state.failWith = null;
  assert.match(await run("alatomy list reminders"), /^No reminders|^#/);
});

test("with no database name, the account DB is used when it is the only one; strangers still get the old message", async () => {
  service.state.reminders = [];
  assert.match(await run('add reminder 2026-10-16T19:00 "implicit"'), /^Added reminder #1: "implicit"/);
  assert.match(await run("list reminders"), /implicit/);
  assert.equal(await run("list reminders", STRANGER), "You don't have access to any database here.");
});

test("deleting from the account DB is confirmed first when it runs through the AI assistant", () => {
  assert.equal(isDestructive(["alatomy", "delete", "reminder", "1"]), true);
  assert.equal(isDestructive(["alatomy", "list", "reminders"]), false);
});

// -------------------------------------------------------------------------- `.a account`, `.a list db`

test(".a account says who you are linked as, or how to link", async () => {
  service.state.reminders = [{ n: 1 }];
  service.state.events = [];
  accountClient.forget(LINKED_DISCORD_ID);
  const linked = makeCtx();
  await accountExecute(linked);
  assert.match(linked.text, /\*\*Alatomy account:\*\* Ada L \(@ada\)/);
  assert.match(linked.text, /`alatomy`: 1 reminder\(s\), 0 event\(s\), 0 tracker\(s\)/);
  assert.match(linked.text, /https:\/\/alatomy\.com\/account/);
  service.state.reminders = [];

  const stranger = makeCtx(STRANGER);
  await accountExecute(stranger);
  assert.match(stranger.text, /isn't linked to an Alatomy account yet/);
});

test(".a list db shows the account DB for a linked person", async () => {
  service.state.reminders = [];
  service.state.events = [];
  accountClient.forget(LINKED_DISCORD_ID);
  const ctx = makeCtx(LINKED_DISCORD_ID, { guildId: null });
  await listExecute(ctx, ["db"]);
  assert.match(ctx.text, /Databases you have access to \(1\)/);
  assert.match(ctx.text, /\*\*alatomy\*\* — Alatomy account DB\nOwner: <@111111111111111111> \(@ada\)\nContains: 0 reminder\(s\), 0 event\(s\), 0 tracker\(s\)/);
  const none = makeCtx(STRANGER);
  await listExecute(none, ["db"]);
  assert.equal(none.text, "You don't own or collaborate on any database.");
});

// -------------------------------------------------------------------------- delivering reminders

function fakeDiscord() {
  const sent = [];
  return {
    sent,
    client: {
      users: { fetch: async (id) => ({ id, username: "ada", send: async (text) => sent.push({ to: `dm:${id}`, text }) }) },
      channels: { fetch: async (id) => ({ send: async (text) => sent.push({ to: `channel:${id}`, text }) }) },
    },
  };
}
const quietLog = { log() {}, error() {} };

test("the scheduler delivers due reminders by DM or in their channel, tags people, and reports them done", async () => {
  const discord = fakeDiscord();
  service.state.delivered = [];
  service.state.due = [
    { id: 11, accountId: ACCOUNT_ID, text: "call mum", remindAt: "2026-10-16T12:00:00.000Z", channelId: null, mentions: [], discordUserId: LINKED_DISCORD_ID },
    { id: 12, accountId: ACCOUNT_ID, text: "standup", remindAt: "2026-10-16T02:00:00.000Z", channelId: "777777777777777777", mentions: ["333333333333333333"], discordUserId: LINKED_DISCORD_ID },
  ];
  const scheduler = createAccountReminderScheduler({ client: accountClient, discord: () => discord.client, log: quietLog });
  await scheduler.tick();
  assert.deepEqual(discord.sent[0], { to: `dm:${LINKED_DISCORD_ID}`, text: "🚨 REMINDER: *call mum* at 19:00 2026/10/16" });
  assert.equal(discord.sent[1].to, "channel:777777777777777777");
  assert.match(discord.sent[1].text, /^🚨 REMINDER: \*standup\* at 09:00 2026\/10\/16 by \*ada\* <@333333333333333333>$/);
  assert.deepEqual(service.state.delivered, ["11", "12"]);
});

test("a reminder is never sent twice, even when the service could not be told it was done", async () => {
  const discord = fakeDiscord();
  const due = [{ id: 21, accountId: ACCOUNT_ID, text: "once", remindAt: "2026-10-16T12:00:00.000Z", channelId: null, mentions: [], discordUserId: LINKED_DISCORD_ID }];
  let doneCalls = 0;
  const client = { isConfigured: () => true, dueTrackers: async () => [], dueReminders: async () => due, markDelivered: async () => { doneCalls += 1; throw new AccountApiError("down"); } };
  const scheduler = createAccountReminderScheduler({ client, discord: () => discord.client, log: quietLog });
  await scheduler.tick();
  await scheduler.tick();
  assert.equal(discord.sent.length, 1);
  assert.equal(doneCalls, 2); // it keeps trying to report it
});

test("a reminder that cannot be delivered is still cleared, and an unconfigured bot does nothing", async () => {
  const done = [];
  const client = {
    isConfigured: () => true,
    dueTrackers: async () => [],
    dueReminders: async () => [{ id: 31, text: "x", remindAt: "2026-10-16T12:00:00.000Z", channelId: null, mentions: [], discordUserId: "1" }],
    markDelivered: async (id) => done.push(id),
  };
  const broken = { users: { fetch: async () => { throw new Error("Unknown User"); } } };
  await createAccountReminderScheduler({ client, discord: () => broken, log: quietLog }).tick();
  assert.deepEqual(done, [31]);

  let asked = false;
  const off = { isConfigured: () => false, dueReminders: async () => { asked = true; return []; } };
  await createAccountReminderScheduler({ client: off, log: quietLog }).tick();
  assert.equal(asked, false);
  assert.equal(createAccountReminderScheduler({ client: off, log: quietLog }).start(), null);
});

test("tracker reminders: one DM per tracker and period, with the count for count trackers, then reported", async () => {
  const discord = fakeDiscord();
  service.state.notified = [];
  service.state.due = [];
  service.state.dueTrackers = [
    { trackerId: 7, discordUserId: LINKED_DISCORD_ID, name: "Took pill B", kind: "count", period: "week", periodKey: "2026-W42", count: 1, target: 3 },
    { trackerId: 8, discordUserId: LINKED_DISCORD_ID, name: "Empty trash", kind: "check", period: "day", periodKey: "2026-10-16", count: 0, target: 1 },
  ];
  const scheduler = createAccountReminderScheduler({ client: accountClient, discord: () => discord.client, log: quietLog });
  await scheduler.tick();
  assert.deepEqual(discord.sent.map((m) => m.text), [
    "⏰ Have you? **Took pill B** (1/3 this week) — tick it off at https://alani.alatomy.com",
    "⏰ Have you? **Empty trash** — tick it off at https://alani.alatomy.com",
  ]);
  assert.deepEqual(service.state.notified, ["7:2026-W42", "8:2026-10-16"]);
  await scheduler.tick(); // the service still lists them (say it missed the report): not sent twice
  assert.equal(discord.sent.length, 2);
  service.state.dueTrackers = [];
});

test("reminders ticked off on the web or already delivered are not listed on Discord", async () => {
  service.state.reminders = [
    { n: 1, text: "pending", remindAt: "2026-10-20T02:00:00.000Z", channelId: null, mentions: [] },
    { n: 2, text: "ticked", remindAt: "2026-10-20T03:00:00.000Z", channelId: null, mentions: [], doneAt: "2026-10-16T00:00:00.000Z" },
    { n: 3, text: "sent", remindAt: "2026-10-14T03:00:00.000Z", channelId: null, mentions: [], deliveredAt: "2026-10-14T03:00:10.000Z" },
  ];
  const listed = await run("alatomy list reminders");
  assert.match(listed, /pending/);
  assert.doesNotMatch(listed, /ticked|sent/);
  service.state.reminders = [];
});

test(".a stats: owners only, command box only, and a readable summary", async () => {
  const stats = {
    accounts: { registered: 52, newLast7Days: 4, newLast30Days: 20, withDiscord: 30, withGoogle: 35 },
    active: { last24Hours: 9, last7Days: 25, last30Days: 41 },
    visits: { website: { today: 120, last7Days: 900, last30Days: 3200, allTime: 15000 }, alani: { today: 40, last7Days: 300, last30Days: 1100, allTime: 1100 } },
  };
  service.state.stats = stats;
  const execute = createStatsExecute({ commandBox: () => "1539866805114372167" });
  const ask = async (userId, channelId) => {
    const ctx = makeCtx(userId, { channelId });
    await execute(ctx);
    return ctx.text;
  };
  assert.equal(await ask(LINKED_DISCORD_ID, "1539866805114372167"), "Only the bot owners can see the stats.");
  assert.equal(await ask("999999999999999999", "555555555555555555"), "Use `.a stats` in the command box channel.");
  const text = await ask("999999999999999999", "1539866805114372167");
  assert.equal(text, formatStats(stats));
  assert.match(text, /\*\*Accounts:\*\* 52 registered \(\+4 in 7 days, \+20 in 30 days\)/);
  assert.match(text, /\*\*Active accounts:\*\* 24 h 9 · 7 days 25 · 30 days 41/);
  assert.match(text, /\*\*alatomy.com page views:\*\* today 120 · 7 days 900 · 30 days 3,200 · all time 15,000/);
  assert.match(text, /\*\*Alani web page views:\*\* today 40/);
});
