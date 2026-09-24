// Indochina Time (ICT, UTC+7, no DST) helpers — the one timezone every
// user-facing time in this bot is expressed in, deliberately independent
// of whatever timezone the host machine happens to be configured with.

export const ICT_OFFSET_MS = 7 * 60 * 60 * 1000;

const pad2 = (n) => String(n).padStart(2, "0");

// Calendar/clock components of `date` as seen in ICT. Everything except
// `year` (a number) is a zero-padded string.
export function ictParts(date) {
  const shifted = new Date(new Date(date).getTime() + ICT_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: pad2(shifted.getUTCMonth() + 1),
    day: pad2(shifted.getUTCDate()),
    hour: pad2(shifted.getUTCHours()),
    minute: pad2(shifted.getUTCMinutes()),
    second: pad2(shifted.getUTCSeconds()),
  };
}

// "DD/MM/YYYY HH:MM" (24h), or "DD/MM/YYYY HH:MM:SS" with { seconds: true }.
export function formatIctDateTime(date, { seconds = false } = {}) {
  const p = ictParts(date);
  const time = `${p.hour}:${p.minute}${seconds ? `:${p.second}` : ""}`;
  return `${p.day}/${p.month}/${p.year} ${time}`;
}
