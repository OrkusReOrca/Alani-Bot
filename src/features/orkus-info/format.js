// Date parsing/formatting for orkus-info, fixed to Indochina Time (ICT,
// UTC+7, no DST) — the timezone this repo's cron schedules are already
// expressed in (see the fortnite workflows' comments) — rather than
// whatever timezone the host server happens to be configured with.
//
// This matters concretely: `new Date("2026-08-20T14:00")` (no offset) is
// parsed as LOCAL time per the ECMA-262 Date Time String Format spec —
// "local" meaning the server process's own system timezone, which is
// NOT guaranteed to match the user's. On bot-hosting.net specifically,
// typing 14:00 came back as "11:00 UTC" — a 3-hour shift, meaning that
// container's local time isn't UTC+7 at all. Explicitly appending
// "+07:00" when no offset is already present makes parsing deterministic
// regardless of the host's own clock/timezone setting.

const ICT_OFFSET_MINUTES = 7 * 60;

function currentIctYearMonth() {
  const shifted = new Date(Date.now() + ICT_OFFSET_MINUTES * 60 * 1000);
  return { year: shifted.getUTCFullYear(), month: String(shifted.getUTCMonth() + 1).padStart(2, "0") };
}

// Expands a partial date into full "YYYY-MM-DD": "DD" alone assumes the
// current ICT year AND month, "MM-DD" assumes the current ICT year only,
// "YYYY-MM-DD" passes through unchanged (each component zero-padded
// either way, so "26-8-5" and "2026-08-05" both work).
function expandPartialDate(datePart) {
  const parts = datePart.split("-").map((p) => p.padStart(2, "0"));
  if (parts.length >= 3) return parts.join("-");
  const { year, month } = currentIctYearMonth();
  if (parts.length === 2) return `${year}-${parts.join("-")}`;
  return `${year}-${month}-${parts[0]}`;
}

// Parses a "[[YYYY-]MM-]DDTHH:MM"-style string (year and/or month
// optional — see expandPartialDate) — or the bare date form,
// "[[YYYY-]MM-]DD", treated as midnight, used for all-day events — as
// ICT, unless it already carries an explicit offset or "Z", in which
// case that's used as-is. Returns a real UTC Date, or null if unparseable.
export function parseIct(value) {
  if (!value) return null;
  const trimmed = value.trim();
  const hasOffset = /[zZ]|[+-]\d{2}:?\d{2}$/.test(trimmed);
  if (hasOffset) {
    const d = new Date(trimmed);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const [datePartRaw, timePart = null] = trimmed.includes("T") ? trimmed.split("T") : [trimmed];
  const datePart = expandPartialDate(datePartRaw);
  const withTime = `${datePart}T${timePart ?? "00:00"}`;
  const d = new Date(`${withTime}+07:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function ictDateParts(date) {
  const shifted = new Date(date.getTime() + ICT_OFFSET_MINUTES * 60 * 1000);
  return {
    yyyy: shifted.getUTCFullYear(),
    mo: String(shifted.getUTCMonth() + 1).padStart(2, "0"),
    dd: String(shifted.getUTCDate()).padStart(2, "0"),
  };
}

// Formats a UTC ISO string back into ICT, "HH:MM YYYY/MM/DD" — the exact
// shape both `.a db add`'s confirmation and the reminder-fired message use.
export function fmtIct(isoUtc) {
  const shifted = new Date(new Date(isoUtc).getTime() + ICT_OFFSET_MINUTES * 60 * 1000);
  const hh = String(shifted.getUTCHours()).padStart(2, "0");
  const mm = String(shifted.getUTCMinutes()).padStart(2, "0");
  const { yyyy, mo, dd } = ictDateParts(new Date(isoUtc));
  return `${hh}:${mm} ${yyyy}/${mo}/${dd}`;
}

// Date-only display, for all-day events — "YYYY/MM/DD", no time.
export function fmtIctDate(isoUtc) {
  const { yyyy, mo, dd } = ictDateParts(new Date(isoUtc));
  return `${yyyy}/${mo}/${dd}`;
}

// Date-only, Google Calendar API shape ("YYYY-MM-DD", for an all-day
// event's date field — distinct from the dateTime field timed events use).
export function ictDateString(date) {
  const { yyyy, mo, dd } = ictDateParts(date);
  return `${yyyy}-${mo}-${dd}`;
}

// Midnight ICT of the same calendar day as `date` (also an ICT moment,
// as a real UTC Date) — normalizes an all-day event's start regardless
// of whether a time component was given (e.g. someone types
// "2026-08-25T14:00 allday" out of habit; the 14:00 gets discarded).
export function startOfIctDay(date) {
  const shifted = new Date(date.getTime() + ICT_OFFSET_MINUTES * 60 * 1000);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - ICT_OFFSET_MINUTES * 60 * 1000);
}
