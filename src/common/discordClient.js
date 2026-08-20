// Shared reference to the logged-in discord.js Client, set once by bot.js
// right after construction. Lets features that need to actively send
// messages or check channel permissions on their own (not just reply to
// whatever triggered them — e.g. orkus-info's reminder scheduler, firing
// on a timer with no interaction/message to reply to) reach the client
// without bot.js having to wire it through every call site individually.

let client = null;

export function setClient(c) {
  client = c;
}

export function getClient() {
  if (!client) {
    throw new Error("Discord client not set yet — bot.js should call setClient() before this is used.");
  }
  return client;
}
