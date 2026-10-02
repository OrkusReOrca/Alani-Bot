// Text formatting for the voice player's replies.

import { isLooping } from "./queue.js";

const MAX_QUEUE_LINES = 25;

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

// durationOf(entry) -> ms | undefined. `playing`/`paused` describe queue[0].
export function describeQueue(state, { durationOf, playing, paused }) {
  if (state.queue.length === 0) return "The queue is empty.";

  const lengths = state.queue.map(durationOf);
  const known = lengths.filter(Number.isFinite);
  const total = known.length === lengths.length ? formatDuration(known.reduce((a, b) => a + b, 0)) : `${formatDuration(known.reduce((a, b) => a + b, 0))}+`;

  const lines = state.queue.slice(0, MAX_QUEUE_LINES).map((entry, i) => {
    const marker = i === 0 ? (playing ? (paused ? "⏸" : "▶") : "⏭") : " ";
    return `${marker} ${i + 1}. ${entry.name} — ${formatDuration(lengths[i])}`;
  });
  if (state.queue.length > MAX_QUEUE_LINES) lines.push(`…and ${state.queue.length - MAX_QUEUE_LINES} more`);

  return [`**Queue** (${state.queue.length} track${state.queue.length === 1 ? "" : "s"}, ${total})`, ...lines, describeSettings(state)].join("\n");
}
