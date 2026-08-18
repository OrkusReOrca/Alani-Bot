const STATUS_EMOJI = {
  idle: "🟡",
  open: "🟢",
  closed: "🔴",
  unknown: "⚪",
};

function fmtDate(d) {
  return d && d.trim() !== "" ? d : "unconfirmed";
}

function formatProgramLine(p, diff) {
  const emoji = STATUS_EMOJI[p.status] ?? "⚪";
  const tag = diff?.changed ? " 🆕 changed" : diff?.isNew ? " 🆕 new" : "";
  const header = `${emoji} **${p.university} — ${p.program}**${tag}`;

  let detail;
  switch (p.status) {
    case "idle":
      detail = `Not yet open. Expected open: ${fmtDate(p.openDate)}`;
      break;
    case "open":
      detail = `Open now. Closes: ${fmtDate(p.closeDate)}`;
      if (p.link) detail += `\nLink: ${p.link}`;
      break;
    case "closed":
      detail = `Closed. Expected next open: ${fmtDate(p.openDate)}`;
      break;
    default:
      detail = "Status unknown / unconfirmed.";
  }

  if (p.notes) detail += `\n_${p.notes}_`;

  return `${header}\n${detail}`;
}

export function formatDailyMessage(programs, diffMap) {
  const sorted = [...programs].sort((a, b) => a.priority - b.priority);

  const lines = sorted.map((p) => formatProgramLine(p, diffMap?.[p.id]));

  const dateStr = new Date().toISOString().slice(0, 10);
  const header = `**📋 Admissions Status Update — ${dateStr}**`;
  const legend = "🟢 open   🟡 idle   🔴 closed   ⚪ unknown/unconfirmed   🆕 changed or newly added";

  return [header, legend, "", lines.join("\n\n")].join("\n");
}

// One line per program whose status actually changed since the last run.
// Returns null if nothing changed (caller should skip sending a DM).
export function formatChangeAlert(programs, diffMap) {
  const changedPrograms = programs.filter((p) => diffMap?.[p.id]?.changed);
  if (changedPrograms.length === 0) return null;

  const lines = changedPrograms.map((p) => {
    const prev = diffMap[p.id].prev;
    const name = `${p.university} — ${p.program}`;
    return `‼️*${name}* Status changed\n(${prev.status} → ${p.status})`;
  });

  return lines.join("\n\n");
}
