// One message listing every track that left today, or null if none did.
export function formatLeftTracksMessage(leftTracks) {
  if (leftTracks.length === 0) return null;

  const lines = leftTracks.map((t) => `- ${t.title}`);
  return [`👋 **Left the Jam Tracks shop today:**`, ...lines].join("\n");
}
