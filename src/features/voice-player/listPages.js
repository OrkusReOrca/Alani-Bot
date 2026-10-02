// Layout of ".avc list": the playable files as pages of a numbered list.
// Pure — the buttons that turn the pages live in common/pagination.js.

import { ictParts } from "../../common/time.js";

export const FILES_PER_PAGE = 15;
export const MAX_NAME_LENGTH = 40;

export const SORTS = {
  a: { title: "A–Z", compare: (x, y) => x.name.localeCompare(y.name, undefined, { sensitivity: "base" }) },
  d: { title: "newest first", compare: (x, y) => Date.parse(y.modifiedTime) - Date.parse(x.modifiedTime) },
};

export function truncateName(name) {
  return name.length > MAX_NAME_LENGTH ? `${name.slice(0, MAX_NAME_LENGTH - 1).trimEnd()}…` : name;
}

function formatDate(isoDate) {
  const { day, month, year } = ictParts(isoDate);
  return `${day}/${month}/${year}`;
}

// files: [{ name, modifiedTime }]; sort: "a" | "d".
// Returns pages: [{ title, description, footer }] — always at least one.
export function buildListPages(files, sort = "a") {
  const { title, compare } = SORTS[sort];
  const heading = `Files to play · ${title}`;
  if (files.length === 0) return [{ title: heading, description: "No playable files found in the Drive folder.", footer: "Page 1 / 1" }];

  const sorted = [...files].sort(compare);
  const pageCount = Math.ceil(sorted.length / FILES_PER_PAGE);

  return Array.from({ length: pageCount }, (_, page) => {
    const start = page * FILES_PER_PAGE;
    const lines = sorted.slice(start, start + FILES_PER_PAGE).map((file, i) => {
      const date = sort === "d" ? ` · ${formatDate(file.modifiedTime)}` : "";
      return `**#${start + i + 1}** - ${truncateName(file.name)}${date}`;
    });
    return { title: heading, description: lines.join("\n"), footer: `Page ${page + 1} / ${pageCount} · ${sorted.length} file${sorted.length === 1 ? "" : "s"}` };
  });
}

// Every file's FULL name, one per line, in the same order as the pages — what
// .aii reads so it can pick files out of the list. (The pages truncate names
// for display; this never does.)
export function buildFileListText(files, sort = "a") {
  const sorted = [...files].sort(SORTS[sort].compare);
  return `${sorted.length} playable file${sorted.length === 1 ? "" : "s"} (${SORTS[sort].title}):\n${sorted.map((file) => `- ${file.name}`).join("\n")}`;
}
