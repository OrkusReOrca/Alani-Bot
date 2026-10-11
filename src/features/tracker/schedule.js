// Recurring schedules: parsing the user's words into a schedule, and the date
// maths to find when it fires. Pure — no clock, no Discord, no database.
//
// A schedule is { kind, time: { h, m }, weekdays?, monthDays?, month?, day? }:
//
//   daily    at:T21:00
//   weekly   friday,sunday at:T19:30             weekdays
//   monthly  1,15 at:T09:00   (or `last`)        days of the month
//   yearly   at:10,03,T09:00                     month, day, time
//
// All times are wall-clock times in the schedule's timezone (minutes east of UTC).
// A monthly/yearly day that a month doesn't have (the 31st, Feb 29) happens on
// that month's last day instead.

import { parseTimeOfDay, parseWeekday, WEEKDAY_NAMES } from "./parse.js";

const MS_PER_MINUTE = 60 * 1000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;
const KINDS = ["daily", "weekly", "monthly", "yearly"];
const LAST = "last";
const MAX_LOOKAHEAD_DAYS = 8 * 366; // enough to find the next Feb 29

const daysInMonth = (year, month1) => new Date(Date.UTC(year, month1, 0)).getUTCDate();
const pad2 = (n) => String(n).padStart(2, "0");

// ---------- parsing ----------

// recurring: "daily" | "weekly" | "monthly" | "yearly"; words: the bare words
// after it ("friday,sunday" / "1,15"); at: the `at:` value ("T21:00", "10,03,T09:00").
// -> { schedule } | { error }
export function parseSchedule({ recurring, words = [], at }) {
  const kind = recurring?.toLowerCase();
  if (!KINDS.includes(kind)) return { error: `\`recuring:\` has to be one of ${KINDS.join(", ")}.` };
  if (!at) return { error: "Say when with `at:` — e.g. `at:T21:00`." };

  const parts = at.split(",").map((p) => p.trim()).filter(Boolean);
  const time = parseTimeOfDay(parts.at(-1));
  if (!time) return { error: "`at:` has to end with a time like `T21:00` (24-hour)." };
  const numbers = parts.slice(0, -1);
  if (numbers.some((n) => !/^\d{1,2}$/.test(n))) return { error: "Before the time, `at:` only takes numbers (month, day)." };
  const listed = words.join(",").split(/[,\s]+/).filter(Boolean);

  if (kind === "daily") return { schedule: { kind, time } };

  if (kind === "weekly") {
    const weekdays = listed.map(parseWeekday);
    if (weekdays.length === 0 || weekdays.includes(null)) return { error: "For weekly, list the days: `recuring:weekly friday,sunday at:T19:30`." };
    return { schedule: { kind, time, weekdays: [...new Set(weekdays)].sort() } };
  }

  if (kind === "monthly") {
    const days = [...listed, ...numbers].map((d) => (d.toLowerCase() === LAST ? LAST : Number(d)));
    if (days.length === 0 || days.some((d) => d !== LAST && !(Number.isInteger(d) && d >= 1 && d <= 31))) return { error: "For monthly, list the days of the month: `recuring:monthly 1,15 at:T09:00` (or `last`)." };
    return { schedule: { kind, time, monthDays: [...new Set(days)] } };
  }

  // yearly
  const [month, day] = numbers.map(Number);
  if (numbers.length !== 2 || !(month >= 1 && month <= 12) || !(day >= 1 && day <= daysInMonth(2024, month))) return { error: "For yearly, give the date before the time: `recuring:yearly at:10,03,T09:00` (month, day)." };
  return { schedule: { kind, time, month, day } };
}

const clock = ({ h, m }) => `${pad2(h)}:${pad2(m)}`;
const joinNice = (items) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

export function describeSchedule(s) {
  switch (s.kind) {
    case "daily":
      return `every day at ${clock(s.time)}`;
    case "weekly":
      return `every ${joinNice(s.weekdays.map((d) => WEEKDAY_NAMES[d]))} at ${clock(s.time)}`;
    case "monthly":
      return `monthly on ${joinNice(s.monthDays.map((d) => (d === LAST ? "the last day" : `day ${d}`)))} at ${clock(s.time)}`;
    default:
      return `every year on ${pad2(s.day)}/${pad2(s.month)} at ${clock(s.time)}`;
  }
}

// ---------- when does it fire? ----------

function firesOn(s, year, month1, day) {
  const last = daysInMonth(year, month1);
  switch (s.kind) {
    case "daily":
      return true;
    case "weekly":
      return s.weekdays.includes(new Date(Date.UTC(year, month1 - 1, day)).getUTCDay());
    case "monthly":
      return s.monthDays.some((d) => (d === LAST ? last : Math.min(d, last)) === day);
    default:
      return s.month === month1 && Math.min(s.day, last) === day;
  }
}

const instantOf = (year, month1, day, time, tzMinutes) => Date.UTC(year, month1 - 1, day, time.h, time.m) - tzMinutes * MS_PER_MINUTE;

// The start of the local day (as a UTC-midnight stamp) that `ms` falls on.
const localDayStart = (ms, tzMinutes) => Math.floor((ms + tzMinutes * MS_PER_MINUTE) / MS_PER_DAY) * MS_PER_DAY;

// Every time the schedule fires in (fromMs, toMs], oldest first.
export function occurrencesBetween(s, tzMinutes, fromMs, toMs) {
  const found = [];
  for (let day = localDayStart(fromMs, tzMinutes) - MS_PER_DAY; day <= toMs + MS_PER_DAY; day += MS_PER_DAY) {
    const date = new Date(day);
    const [year, month1, dayOfMonth] = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
    if (!firesOn(s, year, month1, dayOfMonth)) continue;
    const at = instantOf(year, month1, dayOfMonth, s.time, tzMinutes);
    if (at > fromMs && at <= toMs) found.push(at);
  }
  return found;
}

// The most recent firing no later than `nowMs` and no more than `maxAgeMs` ago, or null.
export function latestOccurrence(s, tzMinutes, nowMs, maxAgeMs) {
  return occurrencesBetween(s, tzMinutes, nowMs - maxAgeMs - 1, nowMs).at(-1) ?? null;
}

// The next firing after `nowMs`, or null if there is none in the foreseeable future.
export function nextOccurrence(s, tzMinutes, nowMs) {
  for (let ahead = 0; ahead <= MAX_LOOKAHEAD_DAYS; ahead += 30) {
    const found = occurrencesBetween(s, tzMinutes, nowMs + ahead * MS_PER_DAY, nowMs + (ahead + 30) * MS_PER_DAY)[0];
    if (found) return found;
  }
  return null;
}

// The local calendar day containing `ms`: [start, end) as real instants.
export function localDay(ms, tzMinutes) {
  const start = localDayStart(ms, tzMinutes) - tzMinutes * MS_PER_MINUTE;
  return { start, end: start + MS_PER_DAY };
}
