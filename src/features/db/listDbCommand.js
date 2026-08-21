// ".a list db" — a read-only, publicly-usable discovery command listing
// DATABASES themselves. NOT the same thing as ".a db list <reminders|
// events>" (which lists RECORDS within one already-resolved database) —
// deliberately a separate top-level command (`data.name = "list"`) so the
// two "list" concepts never collide in the same namespace.
//
// Content depends entirely on who's asking and where, no access is ever
// denied outright (same "publicly discoverable" reasoning as .a info db):
//   - Bot owner, in the command-box channel (or anywhere with no guild,
//     e.g. a DM): every database in the bot, Main included.
//   - Bot owner, in any other guild channel: just what was created in
//     THAT guild — its server-tier database(s), plus any user-tier
//     database that happens to have been created while standing in that
//     same guild (informational only — general-user-db isn't actually
//     guild-restricted the way general-server-db is).
//   - Everyone else, anywhere: only the databases they themselves own or
//     collaborate on (same set `.a db` would auto-select from when no
//     name is given).

import { config } from "../../common/config.js";
import { isOwner, getOwnerIds } from "../../common/auth.js";
import { chunkMessage } from "../../common/discordApi.js";
import * as store from "./store.js";

export const data = {
  name: "list",
};

function formatInstance(instance) {
  const kindLabel = instance.kind === "user" ? "Personal" : "Server";
  const collaborators = instance.kind === "server" ? store.listCollaborators(instance.id) : [];
  const lines = [`**${instance.name}** — ${kindLabel}${instance.status === "frozen" ? " (FROZEN)" : ""}`, `Owner: <@${instance.owner_user_id}>`];
  if (collaborators.length > 0) lines.push(`Collaborators: ${collaborators.map((id) => `<@${id}>`).join(", ")}`);
  lines.push(`Primary channel: ${instance.primary_channel_id === "dm" ? "DM" : `<#${instance.primary_channel_id}>`}`);
  return lines.join("\n");
}

function formatMain() {
  const owners = getOwnerIds().map((id) => `<@${id}>`);
  return [
    "**main** — Main",
    `Owners: ${owners.length > 0 ? owners.join(", ") : "not configured"}`,
    `Primary channel: ${config.commandBoxChannelId ? `<#${config.commandBoxChannelId}>` : "not set"}`,
  ].join("\n");
}

async function replyChunked(ctx, text) {
  for (const chunk of chunkMessage(text)) {
    await ctx.reply(chunk);
  }
}

export async function execute(ctx, args = []) {
  if (args[0]?.toLowerCase() !== "db") {
    await ctx.reply("Usage: `.a list db`");
    return;
  }

  if (isOwner(ctx.userId)) {
    if (!ctx.guildId || ctx.channelId === config.commandBoxChannelId) {
      const all = store.listAccessibleDatabases(ctx.userId, { includeAll: true });
      await replyChunked(ctx, [`**All databases (${all.length + 1}):**`, formatMain(), ...all.map(formatInstance)].join("\n\n"));
      return;
    }
    const inGuild = store.listDatabasesInGuild(ctx.guildId);
    if (inGuild.length === 0) {
      await ctx.reply("No server or personal databases were created in this server.");
      return;
    }
    await replyChunked(ctx, [`**Databases created in this server (${inGuild.length}):**`, ...inGuild.map(formatInstance)].join("\n\n"));
    return;
  }

  const accessible = store.listAccessibleDatabases(ctx.userId);
  if (accessible.length === 0) {
    await ctx.reply("You don't own or collaborate on any database.");
    return;
  }
  await replyChunked(ctx, [`**Databases you have access to (${accessible.length}):**`, ...accessible.map(formatInstance)].join("\n\n"));
}
