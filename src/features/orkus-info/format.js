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

// Parses a "YYYY-MM-DDTHH:MM"-style string as ICT unless it already
// carries an explicit offset or "Z", in which case that's used as-is.
// Returns a real UTC Date, or null if unparseable.
export function parseIct(value) {
  if (!value) return null;
  const hasOffset = /[zZ]|[+-]\d{2}:?\d{2}$/.test(value.trim());
  const d = new Date(hasOffset ? value : `${value}+07:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Formats a UTC ISO string back into ICT, "HH:MM YYYY/MM/DD" — the exact
// shape both `.a db add`'s confirmation and the reminder-fired message use.
export function fmtIct(isoUtc) {
  const shifted = new Date(new Date(isoUtc).getTime() + ICT_OFFSET_MINUTES * 60 * 1000);
  const hh = String(shifted.getUTCHours()).padStart(2, "0");
  const mm = String(shifted.getUTCMinutes()).padStart(2, "0");
  const yyyy = shifted.getUTCFullYear();
  const mo = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(shifted.getUTCDate()).padStart(2, "0");
  return `${hh}:${mm} ${yyyy}/${mo}/${dd}`;
}
