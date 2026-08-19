import { formatDaysLeft } from "./fetchShop.js";

// One combined message: 🟢+ line per new/rerun track (with artist and days
// left), then 🔴+ line per track that left (name only). Returns null if
// there's nothing to report. Discord's 2000-char cap is handled by the
// sender (chunkMessage splits on line boundaries when needed).
export function formatUpdateMessage(newTracks, leftTracks) {
  if (newTracks.length === 0 && leftTracks.length === 0) return null;

  const newLines = newTracks.map(
    (t) => `🟢+ *${t.title}* -- *${t.artist}* -- out date: *${formatDaysLeft(t.outDate)}*`
  );
  const leftLines = leftTracks.map((t) => `🔴+ *${t.title}*`);

  return [...newLines, ...leftLines].join("\n");
}
