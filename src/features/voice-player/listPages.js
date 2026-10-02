// Layout of ".avc list": the playable files as pages of a numbered list.
// Pure — the buttons that turn the pages live in common/pagination.js.

import { ictParts } from "../../common/time.js";
import { groupByMedia, parseSongName, OTHERS } from "./mediaGroups.js";
import { stripExtension } from "./match.js";

export const FILES_PER_PAGE = 15;
export const MAX_NAME_LENGTH = 40;
// Media view (".avc list m"): groups are inline fields, shown as columns.
const FIELDS_PER_PAGE = 9; // 3 columns x 3 rows
const FIELD_VALUE_LIMIT = 1000; // Discord allows 1024 characters per field
const LINES_PER_FIELD = 15;
const PAGE_CHARACTER_BUDGET = 4500; // Discord allows 6000 per embed

export const SORTS = {
  a: { title: "A–Z", compare: (x, y) => x.name.localeCompare(y.name, undefined, { sensitivity: "base" }) },
  d: { title: "newest first", compare: (x, y) => Date.parse(y.modifiedTime) - Date.parse(x.modifiedTime) },
  m: { title: "by media", compare: (x, y) => x.name.localeCompare(y.name, undefined, { sensitivity: "base" }) },
};

export function truncateName(name) {
  return name.length > MAX_NAME_LENGTH ? `${name.slice(0, MAX_NAME_LENGTH - 1).trimEnd()}…` : name;
}

function formatDate(isoDate) {
  const { day, month, year } = ictParts(isoDate);
  return `${day}/${month}/${year}`;
}

// files: [{ name, modifiedTime }]; sort: "a" | "d" | "m".
// Returns pages: [{ title, description, footer }] — always at least one.
export function buildListPages(files, sort = "a") {
  const { title, compare } = SORTS[sort];
  const heading = `Files to play · ${title}`;
  if (files.length === 0) return [{ title: heading, description: "No playable files found in the Drive folder.", footer: "Page 1 / 1" }];

  if (sort === "m") return buildMediaPages(files, heading);

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

// ---------- ".avc list m": columns of media groups ----------

// One group's lines split into fields that fit Discord's limits; every field
// after the first is marked "(2)", "(3)"...
function groupFields(name, lines) {
  const chunks = [];
  let current = [];
  for (const line of lines) {
    const tooLong = [...current, line].join("\n").length > FIELD_VALUE_LIMIT || current.length >= LINES_PER_FIELD;
    if (tooLong && current.length > 0) {
      chunks.push(current);
      current = [];
    }
    current.push(line);
  }
  chunks.push(current);
  const title = truncateName(name);
  return chunks.map((chunk, i) => ({ name: i === 0 ? title : `${title} (${i + 1})`, value: chunk.join("\n") }));
}

function buildMediaPages(files, heading) {
  const { groups, others } = groupByMedia(files);

  const fields = groups.flatMap(({ media, files: songs }) =>
    groupFields(
      media,
      songs.map((file) => {
        const { artist, song } = parseSongName(file.name);
        return truncateName(`${artist} - ${song}`);
      })
    )
  );
  // Songs with no media (or the only one of their media) end up here, shown by full name.
  if (others.length > 0) fields.push(...groupFields(OTHERS, others.map((file) => truncateName(stripExtension(file.name)))));

  // Pack fields into pages: at most 9 (3 columns x 3 rows) and within the embed's size budget.
  const pages = [];
  let current = [];
  let size = 0;
  for (const field of fields) {
    const fieldSize = field.name.length + field.value.length;
    if (current.length > 0 && (current.length >= FIELDS_PER_PAGE || size + fieldSize > PAGE_CHARACTER_BUDGET)) {
      pages.push(current);
      current = [];
      size = 0;
    }
    current.push(field);
    size += fieldSize;
  }
  pages.push(current);

  const summary = `${files.length} file${files.length === 1 ? "" : "s"} · ${groups.length} media group${groups.length === 1 ? "" : "s"}`;
  return pages.map((pageFields, i) => ({ title: heading, fields: pageFields, footer: `Page ${i + 1} / ${pages.length} · ${summary}` }));
}

// Every file's FULL name, one per line, in the same order as the pages — what
// .aii reads so it can pick files out of the list. (The pages truncate names
// for display; this never does.)
export function buildFileListText(files, sort = "a") {
  const count = `${files.length} playable file${files.length === 1 ? "" : "s"}`;

  if (sort === "m") {
    const { groups, others } = groupByMedia(files);
    const sections = [...groups.map(({ media, files: songs }) => ({ media, songs })), ...(others.length > 0 ? [{ media: OTHERS, songs: others }] : [])];
    return `${count} (${SORTS[sort].title}):\n${sections.map(({ media, songs }) => `## ${media}\n${songs.map((file) => `- ${file.name}`).join("\n")}`).join("\n")}`;
  }

  const sorted = [...files].sort(SORTS[sort].compare);
  return `${count} (${SORTS[sort].title}):\n${sorted.map((file) => `- ${file.name}`).join("\n")}`;
}
