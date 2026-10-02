// Grouping of song files by game/media, for ".avc list m".
//
// Files are named  ARTIST-Song name  or  ARTIST-GAME/MEDIA-Song name  (with a
// file extension), e.g. "Hoyomix-Genshin-Ronova Boss Fight Theme.mp4". Only the
// FIRST two dashes separate fields, so a song title may contain dashes itself.
// A media group needs at least two songs; everything else — names without a
// media part, and media with a single song — goes under "Others".

import { stripExtension } from "./match.js";

export const OTHERS = "Others";

// { artist, media, song } — media is null when the name has no media part.
export function parseSongName(fileName) {
  const parts = stripExtension(fileName).split("-");
  if (parts.length < 3) return { artist: parts[0].trim(), media: null, song: parts.slice(1).join("-").trim() };
  return { artist: parts[0].trim(), media: parts[1].trim(), song: parts.slice(2).join("-").trim() };
}

const byText = (x, y) => x.localeCompare(y, undefined, { sensitivity: "base" });

// files: [{ name, ... }]. Returns { groups: [{ media, files }], others: [file] }:
// groups sorted by media name, each group's files sorted by artist then song,
// others sorted by full name. Media names are matched case-insensitively and
// shown the way they were first written.
export function groupByMedia(files) {
  const byMedia = new Map(); // lowercase media -> { media, files }
  const others = [];

  for (const file of files) {
    const { media } = parseSongName(file.name);
    if (!media) {
      others.push(file);
      continue;
    }
    const key = media.toLowerCase();
    if (!byMedia.has(key)) byMedia.set(key, { media, files: [] });
    byMedia.get(key).files.push(file);
  }

  const groups = [];
  for (const group of byMedia.values()) {
    if (group.files.length < 2) others.push(...group.files);
    else groups.push(group);
  }

  const songOrder = (x, y) => {
    const [a, b] = [parseSongName(x.name), parseSongName(y.name)];
    return byText(a.artist, b.artist) || byText(a.song, b.song);
  };
  for (const group of groups) group.files.sort(songOrder);
  groups.sort((x, y) => byText(x.media, y.media));
  others.sort((x, y) => byText(x.name, y.name));
  return { groups, others };
}
