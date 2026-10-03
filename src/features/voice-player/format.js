// Text formatting for the voice player's replies.

import { isLooping, currentEntry } from "./queue.js";
import { truncateName } from "./listPages.js";

export const QUEUE_PAGE_SIZE = 6; // tracks per page of the "All queue" section
const QUEUE_TEXT_LINES = 25; // lines in the plain `queue list` view
const NEIGHBOR_MARKER = "ᛝ";
const SEPARATOR = "-".repeat(36);

// 83000 -> "1:23", 3723000 -> "1:02:03". null/undefined -> "length unknown yet".
export function formatDuration(ms) {
  if (!Number.isFinite(ms)) return "length unknown yet";
  const total = Math.round(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

export function describeSettings(state) {
  const loop = isLooping(state) ? (state.loop ? "on" : "on (because shuffle is on)") : "off";
  return `Loop: **${loop}** · Shuffle: **${state.shuffle ? "on" : "off"}** · PlayCall: **${state.playCall ? "on" : "off"}** · Persistent: **${state.persistent ? "on" : "off"}**`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// "20 tracks, 1:21:13" — with a "+" while some lengths aren't known yet, and
// "length unknown yet" while none are (tracks get their length once converted).
function describeTotals(queue, lengths) {
  const known = lengths.filter(Number.isFinite);
  const tracks = plural(queue.length, "track");
  if (known.length === 0) return `${tracks}, ${formatDuration(undefined)}`;
  const total = formatDuration(known.reduce((sum, ms) => sum + ms, 0));
  return `${tracks}, ${known.length === lengths.length ? total : `${total}+`}`;
}

// ▶ playing, ⏸ paused, ⏭ the track that plays next (not in a call).
const currentMarker = ({ playing, paused }) => (playing ? (paused ? "⏸" : "▶") : "⏭");

// The page of the "All queue" section that holds the current track.
export const queuePageOf = (cursor) => Math.floor(cursor / QUEUE_PAGE_SIZE);

// ".avc queue": pages for the paginator. Every page shows the same top part
// (the previous track, the current one, the next two) and the same settings
// line; only the "All queue" section changes — 6 tracks per page, numbered by
// their place in the queue. durationOf(entry) -> ms | undefined; playing/paused
// describe the current track. Open it on queuePageOf(state.cursor).
export function buildQueuePages(state, { durationOf, playing, paused }) {
  const { queue, cursor } = state;
  const lengths = queue.map(durationOf);
  const marker = currentMarker({ playing, paused });
  const title = queue.length === 0 ? "Queue (empty)" : `Queue (${describeTotals(queue, lengths)})`;
  const settings = describeSettings(state);

  if (queue.length === 0) return [{ title, description: `Nothing is queued.\n\n${settings}`, footer: "Page 1 / 1" }];

  const line = (i, prefix) => `${prefix} ${i + 1}. ${truncateName(queue[i].name)} — ${formatDuration(lengths[i])}`;
  const ended = !currentEntry(state);
  const window = ended
    ? ["Nothing is playing — the queue has ended. Add a track to continue."]
    : [cursor - 1, cursor, cursor + 1, cursor + 2].filter((i) => i >= 0 && i < queue.length).map((i) => line(i, i === cursor ? marker : NEIGHBOR_MARKER));
  const shuffleNote = state.shuffle ? ["(Shuffle is on: the next track is picked at random.)"] : [];

  const pageCount = Math.ceil(queue.length / QUEUE_PAGE_SIZE);
  return Array.from({ length: pageCount }, (_, page) => {
    const start = page * QUEUE_PAGE_SIZE;
    const all = queue.slice(start, start + QUEUE_PAGE_SIZE).map((entry, offset) => {
      const i = start + offset;
      return i === cursor && !ended ? line(i, marker) : `${i + 1}. ${truncateName(entry.name)} — ${formatDuration(lengths[i])}`;
    });
    return {
      title,
      description: [...window, ...shuffleNote, SEPARATOR, "**All queue:**", ...all, "", settings].join("\n"),
      footer: `Page ${page + 1} / ${pageCount}`,
    };
  });
}

// ".avc queue list" / ".avc ql": the whole queue as one plain message, in the
// order tracks were added, with ▶ on the current one. A long queue shows the
// stretch around the current track.
export function describeQueueList(state, { durationOf, playing, paused }) {
  const { queue, cursor } = state;
  if (queue.length === 0) return "The queue is empty.";

  const lengths = queue.map(durationOf);
  const marker = currentMarker({ playing, paused });
  const start = Math.max(0, Math.min(cursor - 5, queue.length - QUEUE_TEXT_LINES));
  const shown = queue.slice(start, start + QUEUE_TEXT_LINES).map((entry, offset) => {
    const i = start + offset;
    return `${i === cursor ? marker : " "} ${i + 1}. ${entry.name} — ${formatDuration(lengths[i])}`;
  });

  const before = start;
  const after = queue.length - (start + shown.length);
  return [
    `**Queue** (${describeTotals(queue, lengths)})`,
    ...(before > 0 ? [`…${before} earlier`] : []),
    ...shown,
    ...(after > 0 ? [`…and ${after} more`] : []),
    describeSettings(state),
  ].join("\n");
}

// The complete queue with full names, for .aii (the pages cut long names).
export function describeQueueForModel(state) {
  const { queue, cursor } = state;
  if (queue.length === 0) return "The queue is empty.";
  return [`${plural(queue.length, "track")} in the queue (in the order they were added):`, ...queue.map((entry, i) => `${i + 1}. ${entry.name}${i === cursor ? "  <- current" : ""}`)].join("\n");
}
