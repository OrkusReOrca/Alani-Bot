const SHOP_API_URL = "https://fortnite-api.com/v2/shop";

// fortnite-api.com mirrors the real in-game shop with no API key required.
// Jam Track entries carry a non-empty `tracks` array; that's the reliable
// signal to filter on (the entry's `layout.name` is NOT always "Jam
// Tracks" — artist-specific bundles use their own layout name — but a
// track entry always has `tracks`).
export async function fetchJamTracks() {
  const res = await fetch(SHOP_API_URL);
  if (!res.ok) {
    throw new Error(`fortnite-api.com shop fetch failed: ${res.status} ${res.statusText}`);
  }
  const { data } = await res.json();

  const jamTracks = [];
  for (const entry of data.entries ?? []) {
    if (!entry.tracks || entry.tracks.length === 0) continue;

    for (const track of entry.tracks) {
      jamTracks.push({
        id: track.id,
        title: track.title,
        image: track.albumArt,
        price: entry.finalPrice,
        outDate: entry.outDate,
      });
    }
  }

  return jamTracks;
}

export function formatDaysLeft(outDateIso) {
  const ms = new Date(outDateIso).getTime() - Date.now();
  if (ms <= 0) return "leaving very soon";
  const totalHours = Math.floor(ms / (1000 * 60 * 60));
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return `${days}d ${hours}h`;
}
