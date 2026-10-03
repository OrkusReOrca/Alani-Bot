// ".aii <request>" — the Discord side of the assistant: checks the caller holds
// AIallowed, gathers the request's context from the message, and hands off to
// assistant.js. Works in any channel, server or DM.

import { isOwner } from "../../common/auth.js";
import { chunkMessage } from "../../common/discordApi.js";
import { sendPaginated } from "../../common/pagination.js";
import { hasTag, TAGS } from "../tags/store.js";
import * as dbStore from "../db/store.js";
import { commands } from "../../commands.js";
import * as llm from "./llm.js";
import * as history from "./history.js";
import { config, limits } from "./config.js";
import { buildContext, buildSystemPrompt } from "./prompt.js";
import { runAssistant } from "./assistant.js";

const TRIGGER = ".aii";
const YES = /^(y|yes|yep|confirm|ok|sure|do it)\b/i;
// Only user mentions may ping — the model's free text can never @everyone or tag a role.
const ALLOWED_MENTIONS = { parse: ["users"], repliedUser: false };

const inFlight = new Set(); // user IDs with a request still running

// The request text after ".aii", or null if `content` isn't an .aii message.
export function parseAiInvocation(content) {
  const [first, ...rest] = content.trim().split(/\s+/);
  return first.toLowerCase() === TRIGGER ? rest.join(" ") : null;
}

function accessibleDatabases(userId) {
  const owner = isOwner(userId);
  const rows = dbStore.listAccessibleDatabases(userId, { includeAll: owner });
  const databases = rows.map((row) => ({ name: row.name, kind: row.kind === "user" ? "personal" : "server" }));
  return owner ? [{ name: "main", kind: "owners' main database, command-box channel only" }, ...databases] : databases;
}

function contextFor(message) {
  return buildContext({
    now: Date.now(),
    user: { id: message.author.id, username: message.author.username },
    channelId: message.channelId,
    channelName: message.channel?.name,
    guildId: message.guildId,
    guildName: message.guild?.name,
    mentionedUsers: [...message.mentions.users.values()].map((u) => ({ id: u.id, username: u.username })),
    mentionedChannels: [...message.mentions.channels.values()].map((c) => ({ id: c.id, name: c.name })),
    voiceChannelId: message.member?.voice?.channelId ?? null,
    databases: accessibleDatabases(message.author.id),
  });
}

function envFor(message) {
  return {
    user: { id: message.author.id },
    channelId: message.channelId,
    guildId: message.guildId,
    voiceChannelId: message.member?.voice?.channelId ?? null,
    post: async (text) => {
      for (const chunk of chunkMessage(text)) await message.reply({ content: chunk, allowedMentions: ALLOWED_MENTIONS });
    },
    postPages: (pages, options) => sendPaginated(message, pages, options),
    postFile: (buffer, name) => message.reply({ files: [{ attachment: buffer, name }], allowedMentions: ALLOWED_MENTIONS }),
    confirm: async (prompt) => {
      await message.reply({ content: prompt, allowedMentions: ALLOWED_MENTIONS });
      const answers = await message.channel.awaitMessages({
        filter: (m) => m.author.id === message.author.id,
        max: 1,
        time: limits.confirmTimeoutMs,
      });
      return YES.test(answers.first()?.content.trim() ?? "");
    },
  };
}

export async function handleAiMessage(message, text) {
  if (!hasTag(message.author.id, TAGS.AIallowed)) {
    await message.reply("You don't have permission to use `.aii` — it needs the AIallowed tag, which only a bot owner can grant.");
    return;
  }
  if (!text) {
    await message.reply("Tell me what to do, e.g. `.aii add a reminder tomorrow 10:00 to call mom`.");
    return;
  }
  if (inFlight.has(message.author.id)) {
    await message.reply("I'm still working on your previous request.");
    return;
  }

  inFlight.add(message.author.id);
  message.channel.sendTyping().catch(() => {});
  try {
    await runAssistant({
      text,
      systemPrompt: buildSystemPrompt(commands, contextFor(message)),
      memory: history.recentTurns(message.author.id, { limit: limits.memoryTurns, withinMs: limits.memoryWindowMs }),
      env: envFor(message),
      commands,
      llm,
      history,
      model: config.model,
    });
  } finally {
    inFlight.delete(message.author.id);
  }
}
