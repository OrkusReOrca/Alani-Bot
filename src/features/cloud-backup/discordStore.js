// Backup storage in a private Discord channel. One backup instance = one
// message whose attachments are the encrypted database files:
//
//   content:      alani-backup <group> <instance name>
//   attachments:  <file>.enc  (see crypto.js)
//
// A message is atomic, so an instance is either fully there or not at all.
// Only messages authored by this bot count — anything anyone else posts in
// the channel is ignored.
//
// The service depends only on this small interface (list / put / get /
// remove), which is what lets its tests use an in-memory store.

import {
  sendFilesViaBotChannel,
  fetchChannelMessages,
  fetchChannelMessage,
  deleteChannelMessage,
  fetchBotUserId,
} from "../../common/discordApi.js";
import { encryptBackup, decryptBackup, CorruptBackupError } from "./crypto.js";

const MESSAGE_PREFIX = "alani-backup";
const MESSAGE_PATTERN = new RegExp(`^${MESSAGE_PREFIX} (\\S+) (\\S+)$`);
const ENCRYPTED_SUFFIX = ".enc";
const PAGE_SIZE = 100;

// key: 32-byte Buffer (see crypto.js parseKey).
export function createDiscordStore({ botToken, channelId, key }) {
  let botUserId = null;

  // What each attachment's authentication tag is bound to.
  const contextFor = (groupId, name, fileName) => `${groupId}/${name}/${fileName}`;

  async function ownBackupMessages() {
    botUserId ??= await fetchBotUserId(botToken);
    const found = [];
    let before;
    for (;;) {
      const page = await fetchChannelMessages(botToken, channelId, { before, limit: PAGE_SIZE });
      for (const message of page) {
        const match = MESSAGE_PATTERN.exec(message.content);
        if (match && message.author.id === botUserId) found.push({ id: message.id, groupId: match[1], name: match[2] });
      }
      if (page.length < PAGE_SIZE) return found;
      before = page.at(-1).id;
    }
  }

  return {
    // A group's instances (normal and FAULTY_), oldest first.
    async list(groupId) {
      return (await ownBackupMessages())
        .filter((item) => item.groupId === groupId)
        .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    },

    // files: { "<file name>": Buffer }. Returns the new item's message id.
    async put(groupId, name, files) {
      const attachments = Object.entries(files).map(([fileName, data]) => ({
        name: `${fileName}${ENCRYPTED_SUFFIX}`,
        data: encryptBackup(data, key, contextFor(groupId, name, fileName)),
      }));
      const message = await sendFilesViaBotChannel(botToken, channelId, attachments, `${MESSAGE_PREFIX} ${groupId} ${name}`);
      return message.id;
    },

    // Decrypts an instance back into { "<file name>": Buffer }. Throws
    // CorruptBackupError if any part fails to authenticate; network/API
    // failures throw plain errors.
    async get(item) {
      // Re-fetched (not taken from listing) so the attachment URLs are fresh.
      const message = await fetchChannelMessage(botToken, channelId, item.id);
      if (message.attachments.length === 0) throw new CorruptBackupError("the backup message has no files");

      const files = {};
      for (const attachment of message.attachments) {
        const res = await fetch(attachment.url);
        if (!res.ok) throw new Error(`Couldn't download backup file ${attachment.filename}: ${res.status}`);
        const fileName = attachment.filename.endsWith(ENCRYPTED_SUFFIX)
          ? attachment.filename.slice(0, -ENCRYPTED_SUFFIX.length)
          : attachment.filename;
        files[fileName] = decryptBackup(Buffer.from(await res.arrayBuffer()), key, contextFor(item.groupId, item.name, fileName));
      }
      return files;
    },

    async remove(item) {
      await deleteChannelMessage(botToken, channelId, item.id);
    },
  };
}
