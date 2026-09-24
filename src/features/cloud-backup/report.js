// Plain-text report of a backup fault, posted to the command box so the
// owner can see exactly what disagreed before choosing which side wins.

const MAX_DIFF_LINES = 15;
const MAX_ROW_CHARS = 180;

const short = (value) => {
  const text = JSON.stringify(value);
  return text.length > MAX_ROW_CHARS ? `${text.slice(0, MAX_ROW_CHARS)}…` : text;
};

function describeDiff({ table, key, a, b }) {
  if (a && !b) return `+ ${table}${key}: on the host, but nothing in the change log explains it — ${short(a)}`;
  if (!a && b) return `- ${table}${key}: the change log says it should exist, but it's missing on the host — ${short(b)}`;
  const fields = Object.keys(a).filter((f) => JSON.stringify(a[f]) !== JSON.stringify(b[f]));
  return `~ ${table}${key}: ${fields.map((f) => `${f}: host ${short(a[f])} vs expected ${short(b[f])}`).join("; ")}`;
}

// problems: [{ kind, message, diffs? }] as produced by verify.js /
// service.js. restoredFrom: name of the stored instance the host was reset
// to (null if no intact one was found).
export function formatFaultReport({ group, problems, restoredFrom, faultyName }) {
  const lines = [`**Cloud backup fault — ${group.label}**`, "", "What didn't add up:"];
  for (const problem of problems) lines.push(`• [${problem.kind}] ${problem.message}`);

  const diffs = problems.flatMap((p) => p.diffs ?? []);
  if (diffs.length > 0) {
    lines.push("", "Rows that differ (host vs stored snapshot + change log):");
    for (const diff of diffs.slice(0, MAX_DIFF_LINES)) lines.push(describeDiff(diff));
    if (diffs.length > MAX_DIFF_LINES) lines.push(`…and ${diffs.length - MAX_DIFF_LINES} more`);
  }

  lines.push(
    "",
    `The host's copy was saved to the backup channel as \`${faultyName}\`.`,
    restoredFrom
      ? `The host has been reset to the last good stored instance (\`${restoredFrom}\`).`
      : "No intact stored instance was found, so the host was left as it is.",
    "",
    "Decide which side to keep (only in this channel):",
    `• \`.a setting cloud resume cloud ${group.id}\` — keep the stored version, discard the faulty copy`,
    `• \`.a setting cloud resume host ${group.id}\` — keep the host's version, save it as the new latest instance`,
    "Changes made on the host after this notice are lost if you choose `host`."
  );
  return lines.join("\n");
}
