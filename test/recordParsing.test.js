import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ADD_EVENT_USAGE, ADD_REMINDER_USAGE, EDIT_EVENT_USAGE, EDIT_REMINDER_USAGE,
  parseAddEvent, parseAddReminder, parseEditEvent, parseEditReminder, parseEventModifiers,
} from "../src/common/recordParsing.js";

// The same parsers serve the local databases and the Alatomy account DB, so these pin the grammar down.
const words = (text) => text.split(/\s+/);

test("add reminder: when, quoted text, then modifiers in any order", () => {
  const parsed = parseAddReminder(words('2026-10-16T19:00 "take out the trash" alice,bob 123456789012345678 force'));
  assert.equal(parsed.text, "take out the trash");
  assert.equal(parsed.remindAt.toISOString(), "2026-10-16T12:00:00.000Z"); // 19:00 in Bangkok (UTC+7)
  assert.equal(parsed.force, true);
  assert.equal(parsed.channelId, "123456789012345678");
  assert.equal(parsed.mentions, "alice,bob");

  const plain = parseAddReminder(words('2026-10-16T19:00 "just text"'));
  assert.deepEqual([plain.force, plain.channelId, plain.mentions], [false, null, null]);
});

test("add reminder: a short time means today, and bad input gives the usage text", () => {
  assert.ok(parseAddReminder(words('T19:00 "today"')).remindAt instanceof Date);
  for (const bad of ['2026-10-16T19:00', '2026-10-16T19:00 "  "', 'nonsense "text"', '"text only"', '2026-10-16T19:00 text without quotes', ""]) {
    assert.equal(parseAddReminder(words(bad)).usage, ADD_REMINDER_USAGE, bad);
  }
});

test("edit reminder: id, time, quoted text", () => {
  assert.deepEqual(
    (({ displayNumber, text }) => ({ displayNumber, text }))(parseEditReminder(words('3 2026-10-16T20:00 "new words"'))),
    { displayNumber: "3", text: "new words" }
  );
  assert.equal(parseEditReminder(words('3 "new words"')).usage, EDIT_REMINDER_USAGE);
  assert.equal(parseEditReminder(words("3 2026-10-16T20:00")).usage, EDIT_REMINDER_USAGE);
});

test("add event: default one hour, explicit end, all day, location after a pipe, force", () => {
  const short = parseAddEvent(words('2026-10-16T14:00 "Standup"'));
  assert.equal(short.endTime.getTime() - short.startTime.getTime(), 60 * 60 * 1000);
  assert.deepEqual([short.allDay, short.force, short.location], [false, false, null]);

  const full = parseAddEvent(words('2026-10-16T14:00 2026-10-16T15:30 "Project meeting" | Room 4 force'));
  assert.equal(full.title, "Project meeting");
  assert.equal(full.endTime.toISOString(), "2026-10-16T08:30:00.000Z");
  assert.equal(full.location, "Room 4 force"); // everything after the pipe is the location; force must come before it
  assert.equal(parseAddEvent(words('2026-10-16T14:00 2026-10-16T15:30 "X" force | Hall')).force, true);

  const day = parseAddEvent(words('2026-10-16T14:00 allday "Holiday"'));
  assert.equal(day.allDay, true);
  assert.equal(day.startTime.toISOString(), "2026-10-15T17:00:00.000Z"); // midnight Bangkok time
  assert.equal(day.endTime.getTime() - day.startTime.getTime(), 24 * 60 * 60 * 1000);
});

test("add event: wrong shapes give the usage text", () => {
  for (const bad of ['2026-10-16T14:00 2026-10-16T13:00 "Backwards"', '2026-10-16T14:00 "  "', 'not-a-date "Title"', '2026-10-16T14:00 not-a-date "Title"', "no quotes at all"]) {
    assert.equal(parseAddEvent(words(bad)).usage, ADD_EVENT_USAGE, bad);
  }
});

test("edit event: id, start, end, title, optional location", () => {
  const parsed = parseEditEvent(words('2 2026-10-16T14:00 2026-10-16T15:00 "Moved" | Annex'));
  assert.deepEqual([parsed.id, parsed.title, parsed.location], ["2", "Moved", "Annex"]);
  assert.equal(parseEditEvent(words('2 2026-10-16T14:00 2026-10-16T15:00 "Moved"')).location, null);
  assert.equal(parseEditEvent(words('2 2026-10-16T15:00 2026-10-16T14:00 "Backwards"')).usage, EDIT_EVENT_USAGE);
  assert.equal(parseEditEvent(words('2 2026-10-16T14:00 "Missing end"')).usage, EDIT_EVENT_USAGE);
});

test("event modifiers", () => {
  assert.deepEqual(parseEventModifiers([]), { force: false, location: null });
  assert.deepEqual(parseEventModifiers(words("FORCE | The Hall")), { force: true, location: "The Hall" });
  assert.deepEqual(parseEventModifiers(["|"]), { force: false, location: null });
});
