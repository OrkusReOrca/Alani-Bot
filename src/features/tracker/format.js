// How tracker data is shown: times in the tracker's own timezone, the paged log
// lists (same look as `.avc list`), and the export text file. Pure.

import { formatTimezone } from "./parse.js";

const LOGS_PER_PAGE = 15;
const MS_PER_MINUTE = 60 * 1000;
const pad2 = (n) => String(n).padStart(2, "0");

// "11/10/2026 21:03" — DD/MM/YYYY and 24-hour time, down to the minute, in the timezone.
export function formatLocal(ms, tzMinutes) {
  const d = new Date(ms + tzMinutes * MS_PER_MINUTE);
  return `${pad2(d.getUTCDate())}/${pad2(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const entries = (n) => (n === 1 ? "1 entry" : `${n} entries`);

// Pages of numbered lines, newest first. `describe(log)` is the line's text.
function pagesOf(logs, { title, noun, tzMinutes, describe }) {
  if (logs.length === 0) return [{ title, description: `No ${noun}s logged yet.`, footer: `Page 1 / 1 · ${formatTimezone(tzMinutes)}` }];
  const pageCount = Math.ceil(logs.length / LOGS_PER_PAGE);
  return Array.from({ length: pageCount }, (_, page) => {
    const start = page * LOGS_PER_PAGE;
    const lines = logs.slice(start, start + LOGS_PER_PAGE).map((log, i) => `**#${start + i + 1}** · ${formatLocal(Date.parse(log.loggedAt), tzMinutes)} · ${describe(log)}`);
    return { title, description: lines.join("\n"), footer: `Page ${page + 1} / ${pageCount} · ${plural(logs.length, noun)} · ${formatTimezone(tzMinutes)}` };
  });
}

export const bpPages = (logs, trackerName, tzMinutes) =>
  pagesOf(logs, { title: `Blood pressure · ${trackerName}`, noun: "reading", tzMinutes, describe: (log) => `**${log.systolic}/${log.diastolic}**` });

export const pillPages = (logs, trackerName, tzMinutes) =>
  pagesOf(logs, { title: `Pills · ${trackerName}`, noun: "log", tzMinutes, describe: (log) => `${log.pillName} · ${log.taken ? "✅ taken" : "❌ not taken"}` });

// ---------- exports ----------

// Oldest first, so the file reads like a diary.
const chronological = (logs) => [...logs].reverse();

function exportText({ heading, columns, logs, rows, tzMinutes, rangeText, nowMs }) {
  return [
    heading,
    `Exported ${formatLocal(nowMs, tzMinutes)} (${formatTimezone(tzMinutes)}) · ${entries(logs.length)} · ${rangeText}`,
    columns,
    "",
    ...rows(chronological(logs)),
    "",
  ].join("\n");
}

export const bpExportText = (logs, { trackerName, tzMinutes, rangeText, nowMs }) =>
  exportText({
    heading: `${trackerName} — blood pressure log`,
    columns: "date time, systolic/diastolic",
    logs,
    tzMinutes,
    rangeText,
    nowMs,
    rows: (ordered) => ordered.map((log) => `${formatLocal(Date.parse(log.loggedAt), tzMinutes)}  ${log.systolic}/${log.diastolic}`),
  });

export const pillExportText = (logs, { trackerName, tzMinutes, rangeText, nowMs }) =>
  exportText({
    heading: `${trackerName} — pill log`,
    columns: "date time, pill, taken",
    logs,
    tzMinutes,
    rangeText,
    nowMs,
    rows: (ordered) => ordered.map((log) => `${formatLocal(Date.parse(log.loggedAt), tzMinutes)}  ${log.pillName}  ${log.taken ? "yes" : "no"}`),
  });

export function exportFileName(prefix, nowMs, tzMinutes) {
  const d = new Date(nowMs + tzMinutes * MS_PER_MINUTE);
  return `${prefix}-${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}.txt`;
}
