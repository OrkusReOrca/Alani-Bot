import { formatDaysLeft } from "./fetchShop.js";

export function formatNewTrackEmbed(track) {
  return {
    title: track.title,
    color: 0x8557f5,
    image: { url: track.image },
    fields: [
      { name: "Price", value: `${track.price} V-Bucks`, inline: true },
      { name: "Days Left", value: formatDaysLeft(track.outDate), inline: true },
    ],
    footer: { text: "New in the Jam Tracks shop" },
  };
}

// One message listing every track that left today, or null if none did.
export function formatLeftTracksMessage(leftTracks) {
  if (leftTracks.length === 0) return null;

  const lines = leftTracks.map((t) => `- ${t.title}`);
  return [`👋 **Left the Jam Tracks shop today:**`, ...lines].join("\n");
}
