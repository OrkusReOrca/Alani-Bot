// Parsing of tracker command text. Pure — nothing here touches Discord or a database.

const MS_PER_MINUTE = 60 * 1000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;
const MAX_TZ_MINUTES = 14 * 60;

// ---------- options and words ----------

// One of: key:"quoted value" | key:value | "a"/"b" | "quoted" | bare word.
const TOKEN = /([A-Za-z]+):"([^"]*)"|([A-Za-z]+):(\S+)|"([^"]*)"\/"([^"]*)"|"([^"]*)"|(\S+)/g;

// Splits command text into ordered tokens:
//   { kind: "option", key, value }   recuring:daily  ·  to:"Take a break"  ·  at:T21:00
//   { kind: "pair", first, second }  "Bloodpressure lowerer"/"bpl"
//   { kind: "quoted", value }        "Fortnite karaoke weekly"
//   { kind: "word", value }          friday,sunday  ·  server  ·  120
// Option keys are lowercased, and the "recuring" misspelling is accepted as "recurring".
// Curly quotes (phone keyboards) count as straight ones.
export function tokenize(text) {
  const straight = text.replace(/[“”„]/g, '"');
  const tokens = [];
  for (const m of straight.matchAll(TOKEN)) {
    if (m[1] !== undefined) tokens.push(option(m[1], m[2]));
    else if (m[3] !== undefined) tokens.push(option(m[3], m[4]));
    else if (m[5] !== undefined) tokens.push({ kind: "pair", first: m[5].trim(), second: m[6].trim() });
    else if (m[7] !== undefined) tokens.push({ kind: "quoted", value: m[7].trim() });
    else tokens.push({ kind: "word", value: m[8] });
  }
  return tokens;
}

function option(key, value) {
  const lower = key.toLowerCase();
  return { kind: "option", key: lower === "recuring" ? "recurring" : lower, value };
}

export const optionsOf = (tokens) => Object.fromEntries(tokens.filter((t) => t.kind === "option").map((t) => [t.key, t.value]));
export const wordsOf = (tokens) => tokens.filter((t) => t.kind === "word").map((t) => t.value);
export const quotedOf = (tokens) => tokens.filter((t) => t.kind === "quoted").map((t) => t.value);

// Splits "a,b,c" on commas that aren't inside quotes; quotes are removed.
export function splitList(text) {
  const parts = [];
  let current = "";
  let inQuotes = false;
  for (const char of text.replace(/[“”„]/g, '"')) {
    if (char === '"') inQuotes = !inQuotes;
    else if (char === "," && !inQuotes) {
      parts.push(current);
      current = "";
    } else current += char;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

// ---------- times ----------

// "GMT+7", "UTC-5", "+7", "GMT+5:30" -> minutes east of UTC, or null.
export function parseTimezone(text) {
  const m = /^(?:GMT|UTC)?([+-])(\d{1,2})(?::?(\d{2}))?$/i.exec(text?.trim() ?? "");
  if (!m) return null;
  const minutes = (Number(m[2]) * 60 + Number(m[3] ?? 0)) * (m[1] === "-" ? -1 : 1);
  return Math.abs(minutes) <= MAX_TZ_MINUTES ? minutes : null;
}

export function formatTimezone(minutes) {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  const [h, m] = [Math.floor(abs / 60), abs % 60];
  return `GMT${sign}${h}${m ? `:${String(m).padStart(2, "0")}` : ""}`;
}

// "T21:00" or "21:00" -> { h, m }, or null.
export function parseTimeOfDay(text) {
  const m = /^T?(\d{1,2}):(\d{2})$/i.exec(text?.trim() ?? "");
  if (!m) return null;
  const [h, min] = [Number(m[1]), Number(m[2])];
  return h <= 23 && min <= 59 ? { h, m: min } : null;
}

export const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// "friday", "Fri", "tues", "thurs" -> 0 (Sunday) .. 6, or null.
export function parseWeekday(text) {
  const word = text?.trim().toLowerCase() ?? "";
  if (word === "tues") return 2;
  if (word === "thurs") return 4;
  const index = word.length >= 3 ? WEEKDAY_NAMES.findIndex((name) => name.toLowerCase().startsWith(word)) : -1;
  return index >= 0 ? index : null;
}

// ---------- ranges: latestX | oldestX | date-date | all ----------

const DATE = "(\\d{4})[/.](\\d{1,2})[/.](\\d{1,2})";
const toDate = (y, m, d) => ({ y: Number(y), m: Number(m), d: Number(d) });
const validDate = ({ y, m, d }) => m >= 1 && m <= 12 && d >= 1 && d <= new Date(Date.UTC(y, m, 0)).getUTCDate();

// -> { kind: "all" } | { kind: "latest"|"oldest", count } | { kind: "dates", from, to } | { error }
export function parseRange(text) {
  const t = (text ?? "").trim().toLowerCase();
  if (t === "all") return { kind: "all" };

  const count = /^(latest|oldest)(\d+)$/.exec(t);
  if (count) return Number(count[2]) > 0 ? { kind: count[1], count: Number(count[2]) } : { error: "The number has to be at least 1." };

  const span = new RegExp(`^${DATE}(?:-${DATE})?$`).exec(t);
  if (span) {
    const from = toDate(span[1], span[2], span[3]);
    const to = span[4] ? toDate(span[4], span[5], span[6]) : from;
    if (!validDate(from) || !validDate(to)) return { error: "That isn't a real date." };
    if (Date.UTC(from.y, from.m - 1, from.d) > Date.UTC(to.y, to.m - 1, to.d)) return { error: "The first date has to come before the second." };
    return { kind: "dates", from, to };
  }
  return { error: "Use `latestX`, `oldestX`, `YYYY/M/D-YYYY/M/D` or `all` (e.g. `latest14`, `2026/10/1-2026/11/13`)." };
}

// Picks the logs a range covers. `logs` must be newest first ({ loggedAt: ISO });
// the result keeps that order. Dates are whole days in the tracker's timezone, both ends included.
export function selectLogs(logs, range, tzMinutes) {
  switch (range.kind) {
    case "all":
      return logs;
    case "latest":
      return logs.slice(0, range.count);
    case "oldest":
      return logs.slice(Math.max(0, logs.length - range.count));
    default: {
      const start = Date.UTC(range.from.y, range.from.m - 1, range.from.d) - tzMinutes * MS_PER_MINUTE;
      const end = Date.UTC(range.to.y, range.to.m - 1, range.to.d) + MS_PER_DAY - tzMinutes * MS_PER_MINUTE;
      return logs.filter((log) => {
        const at = Date.parse(log.loggedAt);
        return at >= start && at < end;
      });
    }
  }
}

export function describeRange(range) {
  switch (range.kind) {
    case "all":
      return "all logs";
    case "latest":
      return `the latest ${range.count}`;
    case "oldest":
      return `the oldest ${range.count}`;
    default: {
      const f = ({ y, m, d }) => `${y}/${m}/${d}`;
      return range.from.y === range.to.y && range.from.m === range.to.m && range.from.d === range.to.d ? f(range.from) : `${f(range.from)} to ${f(range.to)}`;
    }
  }
}
