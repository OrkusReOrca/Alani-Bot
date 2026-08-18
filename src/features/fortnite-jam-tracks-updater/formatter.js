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

const GROUP_THRESHOLD = 6;
const GROUP_SIZE = 4;

// >6 new tracks: batch into messages of up to 4 embeds each (keeps a big
// shop refresh from posting a wall of individual messages). 6 or fewer:
// one message per track, so a normal day's handful of new tracks each get
// their own clean card.
export function groupNewTrackEmbeds(newTracks) {
  const embeds = newTracks.map(formatNewTrackEmbed);
  if (newTracks.length <= GROUP_THRESHOLD) {
    return embeds.map((embed) => [embed]);
  }

  const groups = [];
  for (let i = 0; i < embeds.length; i += GROUP_SIZE) {
    groups.push(embeds.slice(i, i + GROUP_SIZE));
  }
  return groups;
}
