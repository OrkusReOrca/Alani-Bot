import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveType, TYPES, creatableTypeNames } from "../src/features/tracker/types.js";
import { tokenize, optionsOf, wordsOf, quotedOf, splitList, parseTimezone, formatTimezone, parseTimeOfDay, parseWeekday, parseRange, selectLogs, describeRange } from "../src/features/tracker/parse.js";
import { parseSchedule, describeSchedule, occurrencesBetween, latestOccurrence, nextOccurrence, localDay } from "../src/features/tracker/schedule.js";

const GMT7 = 7 * 60;
const at = (y, mo, d, h = 0, mi = 0, tz = GMT7) => Date.UTC(y, mo - 1, d, h, mi) - tz * 60000; // a wall-clock time in a timezone

// ---------- the hierarchy ----------
test("types: only the smallest subsets can be created; categories explain what's under them", () => {
  assert.equal(resolveType("Bloodpressure tracker").type.type, "bloodpressure");
  assert.equal(resolveType("bloodpressure   TRACKER").type.type, "bloodpressure");
  assert.equal(resolveType("bp").type.type, "bloodpressure");
  assert.equal(resolveType("Pill tracker").type.type, "pill");
  assert.equal(resolveType("Activity tracker").type.type, "activity");

  const health = resolveType("Health tracker");
  assert.equal(health.status, "category");
  assert.deepEqual(health.creatable.map((t) => t.name), ["Bloodpressure tracker", "Pill tracker"]);
  assert.deepEqual(resolveType("Routine tracker").creatable.map((t) => t.name), ["Activity tracker"]);
  assert.equal(resolveType("Tracker").status, "category");
  assert.equal(resolveType("Tracker").creatable.length, 3);
  assert.equal(resolveType("nonsense").status, "none");
});

test("types: the path through the tree, and which types allow only one per owner", () => {
  assert.deepEqual(TYPES.bloodpressure.path, ["Tracker", "Health tracker", "Bloodpressure tracker"]);
  assert.deepEqual(TYPES.activity.path, ["Tracker", "Routine tracker", "Activity tracker"]);
  assert.equal(TYPES.bloodpressure.onePerOwner, true);
  assert.equal(TYPES.pill.onePerOwner, true);
  assert.equal(TYPES.activity.onePerOwner, false);
  assert.equal(creatableTypeNames().length, 3);
});

// ---------- tokenizing ----------
test("tokenize: the create command", () => {
  const tokens = tokenize('create type:"Bloodpressure tracker" me');
  assert.deepEqual(tokens, [
    { kind: "word", value: "create" },
    { kind: "option", key: "type", value: "Bloodpressure tracker" },
    { kind: "word", value: "me" },
  ]);
});

test("tokenize: your karaoke setting example, apostrophes and all", () => {
  const tokens = tokenize('"Fortnite karaoke weekly" recuring:weekly friday,sunday at:T19:30 to:"It\'s Karaoke Time!!!" tag:higgorca,david,sam sent:123456789');
  assert.deepEqual(quotedOf(tokens), ["Fortnite karaoke weekly"]);
  assert.deepEqual(wordsOf(tokens), ["friday,sunday"]);
  assert.deepEqual(optionsOf(tokens), { recurring: "weekly", at: "T19:30", to: "It's Karaoke Time!!!", tag: "higgorca,david,sam", sent: "123456789" });
});

test("tokenize: the blood pressure setting, a pill name pair, curly quotes, and yearly at:", () => {
  assert.deepEqual(optionsOf(tokenize('"Bloodpressure tracker" recurring:daily at:T21:00 to:"Register today blood pressure" sent:dm')), {
    recurring: "daily",
    at: "T21:00",
    to: "Register today blood pressure",
    sent: "dm",
  });
  assert.deepEqual(tokenize('addpill "Bloodpressure lowerer"/"bpl" recuring:daily')[1], { kind: "pair", first: "Bloodpressure lowerer", second: "bpl" });
  assert.deepEqual(quotedOf(tokenize("enable “Pill tracker” me")), ["Pill tracker"]);
  assert.equal(optionsOf(tokenize("recuring:yearly at:10,03,T09:00")).at, "10,03,T09:00");
});

test("splitList splits on commas outside quotes", () => {
  assert.deepEqual(splitList("bpl,fl"), ["bpl", "fl"]);
  assert.deepEqual(splitList('"bloodpressure lowerer","fat lowerer"'), ["bloodpressure lowerer", "fat lowerer"]);
  assert.deepEqual(splitList('"a, b",c'), ["a, b", "c"]);
  assert.deepEqual(splitList(" , x ,, "), ["x"]);
});

// ---------- times ----------
test("timezones, times of day and weekdays", () => {
  assert.equal(parseTimezone("GMT+7"), 420);
  assert.equal(parseTimezone("gmt-5"), -300);
  assert.equal(parseTimezone("UTC+5:30"), 330);
  assert.equal(parseTimezone("+9"), 540);
  assert.equal(parseTimezone("GMT+15"), null);
  assert.equal(parseTimezone("tomorrow"), null);
  assert.equal(formatTimezone(420), "GMT+7");
  assert.equal(formatTimezone(-300), "GMT-5");
  assert.equal(formatTimezone(330), "GMT+5:30");

  assert.deepEqual(parseTimeOfDay("T21:00"), { h: 21, m: 0 });
  assert.deepEqual(parseTimeOfDay("9:05"), { h: 9, m: 5 });
  assert.equal(parseTimeOfDay("T25:00"), null);
  assert.equal(parseTimeOfDay("T21:60"), null);
  assert.equal(parseTimeOfDay("evening"), null);

  assert.deepEqual(["friday", "Fri", "SUN", "tues", "thurs", "thu"].map(parseWeekday), [5, 5, 0, 2, 4, 4]);
  assert.deepEqual(["sunshine", "fr", "", "x"].map(parseWeekday), [null, null, null, null]);
});

// ---------- ranges ----------
test("parseRange understands all, latestX, oldestX and date ranges, and rejects nonsense", () => {
  assert.deepEqual(parseRange("all"), { kind: "all" });
  assert.deepEqual(parseRange("latest14"), { kind: "latest", count: 14 });
  assert.deepEqual(parseRange("OLDEST3"), { kind: "oldest", count: 3 });
  assert.deepEqual(parseRange("2026/10/1-2026/11/13"), { kind: "dates", from: { y: 2026, m: 10, d: 1 }, to: { y: 2026, m: 11, d: 13 } });
  assert.deepEqual(parseRange("2026/10/5"), { kind: "dates", from: { y: 2026, m: 10, d: 5 }, to: { y: 2026, m: 10, d: 5 } });
  for (const bad of ["latest0", "latest", "2026/13/1-2026/13/2", "2026/2/30", "2026/11/13-2026/10/1", "yesterday", ""]) {
    assert.ok(parseRange(bad).error, bad);
  }
});

test("selectLogs: newest-first logs; latest/oldest pick from the right end; dates are whole local days, both ends included", () => {
  const log = (iso) => ({ loggedAt: iso });
  const logs = [log("2026-10-14T20:00:00Z"), log("2026-10-13T16:59:00Z"), log("2026-10-13T17:01:00Z"), log("2026-10-12T05:00:00Z"), log("2026-10-01T00:00:00Z")]; // newest first
  logs.sort((a, b) => b.loggedAt.localeCompare(a.loggedAt));

  assert.deepEqual(selectLogs(logs, { kind: "latest", count: 2 }, GMT7).map((l) => l.loggedAt), [logs[0].loggedAt, logs[1].loggedAt]);
  assert.deepEqual(selectLogs(logs, { kind: "oldest", count: 2 }, GMT7).map((l) => l.loggedAt), [logs[3].loggedAt, logs[4].loggedAt]);
  assert.equal(selectLogs(logs, { kind: "all" }, GMT7).length, 5);
  assert.equal(selectLogs(logs, { kind: "latest", count: 99 }, GMT7).length, 5);

  // 12 to 13 Oct in GMT+7 = 2026-10-11T17:00Z up to (not including) 2026-10-13T17:00Z.
  const range = parseRange("2026/10/12-2026/10/13");
  assert.deepEqual(selectLogs(logs, range, GMT7).map((l) => l.loggedAt), ["2026-10-13T16:59:00Z", "2026-10-12T05:00:00Z"]);
  assert.equal(describeRange(range), "2026/10/12 to 2026/10/13");
  assert.equal(describeRange(parseRange("latest14")), "the latest 14");
});

// ---------- schedules ----------
test("parseSchedule: your examples, and the monthly / yearly forms", () => {
  assert.deepEqual(parseSchedule({ recurring: "daily", at: "T21:00" }).schedule, { kind: "daily", time: { h: 21, m: 0 } });
  assert.deepEqual(parseSchedule({ recurring: "weekly", words: ["friday,sunday"], at: "T19:30" }).schedule, { kind: "weekly", time: { h: 19, m: 30 }, weekdays: [0, 5] });
  assert.deepEqual(parseSchedule({ recurring: "weekly", words: ["Friday,", "sun"], at: "T19:30" }).schedule.weekdays, [0, 5]);
  assert.deepEqual(parseSchedule({ recurring: "monthly", words: ["1,15"], at: "T09:00" }).schedule.monthDays, [1, 15]);
  assert.deepEqual(parseSchedule({ recurring: "monthly", words: ["last"], at: "T09:00" }).schedule.monthDays, ["last"]);
  assert.deepEqual(parseSchedule({ recurring: "monthly", at: "15,T09:00" }).schedule.monthDays, [15]); // day inside at:
  assert.deepEqual(parseSchedule({ recurring: "yearly", at: "10,03,T09:00" }).schedule, { kind: "yearly", time: { h: 9, m: 0 }, month: 10, day: 3 });
});

test("parseSchedule: helpful errors", () => {
  const error = (input) => parseSchedule(input).error;
  assert.match(error({ recurring: "hourly", at: "T21:00" }), /one of daily, weekly, monthly, yearly/);
  assert.match(error({ recurring: "daily" }), /Say when with `at:`/);
  assert.match(error({ recurring: "daily", at: "evening" }), /end with a time/);
  assert.match(error({ recurring: "weekly", at: "T19:30" }), /list the days/);
  assert.match(error({ recurring: "weekly", words: ["someday"], at: "T19:30" }), /list the days/);
  assert.match(error({ recurring: "monthly", words: ["40"], at: "T09:00" }), /days of the month/);
  assert.match(error({ recurring: "yearly", at: "T09:00" }), /month, day/);
  assert.match(error({ recurring: "yearly", at: "2,30,T09:00" }), /month, day/);
});

test("describeSchedule reads naturally", () => {
  assert.equal(describeSchedule(parseSchedule({ recurring: "daily", at: "T21:00" }).schedule), "every day at 21:00");
  assert.equal(describeSchedule(parseSchedule({ recurring: "weekly", words: ["friday,sunday"], at: "T19:30" }).schedule), "every Sunday and Friday at 19:30");
  assert.equal(describeSchedule(parseSchedule({ recurring: "monthly", words: ["1,last"], at: "T09:00" }).schedule), "monthly on day 1 and the last day at 09:00");
  assert.equal(describeSchedule(parseSchedule({ recurring: "yearly", at: "10,03,T09:00" }).schedule), "every year on 03/10 at 09:00");
});

test("daily 21:00 GMT+7 fires at 14:00 UTC each day", () => {
  const daily = { kind: "daily", time: { h: 21, m: 0 } };
  assert.deepEqual(occurrencesBetween(daily, GMT7, at(2026, 10, 11, 0, 0), at(2026, 10, 13, 23, 59)), [at(2026, 10, 11, 21), at(2026, 10, 12, 21), at(2026, 10, 13, 21)]);
  assert.equal(at(2026, 10, 11, 21), Date.UTC(2026, 9, 11, 14, 0));
  // (from, to] — the start is excluded, the end included.
  assert.deepEqual(occurrencesBetween(daily, GMT7, at(2026, 10, 11, 21), at(2026, 10, 12, 21)), [at(2026, 10, 12, 21)]);
});

test("timezone changes the instant, not the wall-clock time", () => {
  const daily = { kind: "daily", time: { h: 21, m: 0 } };
  // 21:00 in GMT-5 is 02:00 UTC the next day: local Oct 10 -> Oct 11 02:00Z, which is the only one inside Oct 11 00:00Z..Oct 12 00:00Z.
  assert.deepEqual(occurrencesBetween(daily, -300, Date.UTC(2026, 9, 11), Date.UTC(2026, 9, 12)), [Date.UTC(2026, 9, 11, 2, 0)]);
});

test("weekly friday,sunday only fires on those days", () => {
  const weekly = parseSchedule({ recurring: "weekly", words: ["friday,sunday"], at: "T19:30" }).schedule;
  const fired = occurrencesBetween(weekly, GMT7, at(2026, 10, 5), at(2026, 10, 12));
  assert.deepEqual(fired, [at(2026, 10, 9, 19, 30), at(2026, 10, 11, 19, 30)]); // Fri 9th, Sun 11th
});

test("monthly: listed days, `last`, and months too short for the day", () => {
  const monthly = (words) => parseSchedule({ recurring: "monthly", words, at: "T09:00" }).schedule;
  assert.deepEqual(occurrencesBetween(monthly(["1,15"]), GMT7, at(2026, 10, 1), at(2026, 12, 20)), [at(2026, 10, 1, 9), at(2026, 10, 15, 9), at(2026, 11, 1, 9), at(2026, 11, 15, 9), at(2026, 12, 1, 9), at(2026, 12, 15, 9)]);
  assert.deepEqual(occurrencesBetween(monthly(["last"]), GMT7, at(2026, 1, 1), at(2026, 3, 31, 23)), [at(2026, 1, 31, 9), at(2026, 2, 28, 9), at(2026, 3, 31, 9)]);
  assert.deepEqual(occurrencesBetween(monthly(["31"]), GMT7, at(2026, 4, 1), at(2026, 4, 30, 23)), [at(2026, 4, 30, 9)]); // April has no 31st: the 30th
});

test("yearly fires once a year, and Feb 29 falls back to Feb 28 in other years", () => {
  const yearly = parseSchedule({ recurring: "yearly", at: "10,03,T09:00" }).schedule;
  assert.deepEqual(occurrencesBetween(yearly, GMT7, at(2026, 1, 1), at(2028, 12, 31)), [at(2026, 10, 3, 9), at(2027, 10, 3, 9), at(2028, 10, 3, 9)]);
  const leap = parseSchedule({ recurring: "yearly", at: "2,29,T09:00" }).schedule;
  assert.deepEqual(occurrencesBetween(leap, GMT7, at(2027, 1, 1), at(2028, 12, 31)), [at(2027, 2, 28, 9), at(2028, 2, 29, 9)]);
});

test("latestOccurrence only looks back a limited time (for catching up after downtime)", () => {
  const daily = { kind: "daily", time: { h: 21, m: 0 } };
  const hour = 60 * 60 * 1000;
  assert.equal(latestOccurrence(daily, GMT7, at(2026, 10, 11, 21, 20), hour), at(2026, 10, 11, 21)); // 20 minutes late
  assert.equal(latestOccurrence(daily, GMT7, at(2026, 10, 11, 22, 30), hour), null); // 90 minutes late: too old
  assert.equal(latestOccurrence(daily, GMT7, at(2026, 10, 11, 21), hour), at(2026, 10, 11, 21)); // exactly on time
  assert.equal(latestOccurrence(daily, GMT7, at(2026, 10, 11, 20, 59), hour), null); // yesterday's 21:00 was nearly a day ago
});

test("nextOccurrence finds the upcoming firing, even months or years away", () => {
  const daily = { kind: "daily", time: { h: 21, m: 0 } };
  assert.equal(nextOccurrence(daily, GMT7, at(2026, 10, 11, 20)), at(2026, 10, 11, 21));
  assert.equal(nextOccurrence(daily, GMT7, at(2026, 10, 11, 21)), at(2026, 10, 12, 21)); // already fired: tomorrow
  const yearly = parseSchedule({ recurring: "yearly", at: "10,03,T09:00" }).schedule;
  assert.equal(nextOccurrence(yearly, GMT7, at(2026, 10, 11)), at(2027, 10, 3, 9));
  const leap = parseSchedule({ recurring: "yearly", at: "2,29,T09:00" }).schedule;
  assert.equal(nextOccurrence(leap, GMT7, at(2026, 3, 1)), at(2027, 2, 28, 9));
});

test("localDay is the calendar day in the tracker's timezone", () => {
  const { start, end } = localDay(at(2026, 10, 11, 23, 59), GMT7);
  assert.equal(start, at(2026, 10, 11, 0, 0));
  assert.equal(end, at(2026, 10, 12, 0, 0));
  assert.equal(localDay(at(2026, 10, 11, 0, 1), GMT7).start, at(2026, 10, 11, 0, 0));
  assert.equal(localDay(Date.UTC(2026, 9, 11, 20), GMT7).start, at(2026, 10, 12, 0, 0)); // 20:00Z is already the 12th in GMT+7
});
