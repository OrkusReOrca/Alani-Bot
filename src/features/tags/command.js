// ".a tag add|remove <tag> <user>" and ".a tag list <tag>" — owner-only.
// <user> is a user ID, an @mention, or a username (looked up in the current
// server). See store.js for what tags exist.

import { isOwner, getOwnerIds } from "../../common/auth.js";
import { resolveMentions } from "../../common/mentions.js";
import { TAGS, canonicalTag, hasTag, addTag, removeTag, listTagHolders } from "./store.js";

export const data = {
  name: "tag",
};

export const aiGuide = `
.a tag add <tag> <user>      — grant a tag (owner only)
.a tag remove <tag> <user>   — revoke a tag (owner only)
.a tag list <tag>            — who holds a tag (owner only)
Tags: ${Object.values(TAGS).join(", ")}. AIallowed lets a user use .aii and .a emo; bot owners always have it.
<user> is a user ID, an <@id> mention, or a username.`;

export const isDestructive = (args) => args[0]?.toLowerCase() === "remove";

const USAGE = `Usage: \`.a tag add|remove <${Object.values(TAGS).join("|")}> <user>\` · \`.a tag list <tag>\``;

async function resolveUser(token, guildId) {
  const id = /^<@!?(\d+)>$/.exec(token)?.[1] ?? token;
  const { resolved } = await resolveMentions(id, guildId);
  return resolved[0] ?? null;
}

const mentionList = (ids) => ids.map((id) => `<@${id}>`).join(" ");

export async function execute(ctx, args = []) {
  if (!isOwner(ctx.userId)) {
    await ctx.reply("Unauthorized user, no permission");
    return;
  }

  const [action, tagArg, userArg] = args;
  const tag = canonicalTag(tagArg);
  const verb = action?.toLowerCase();
  if (!["add", "remove", "list"].includes(verb) || !tag) {
    await ctx.reply(USAGE);
    return;
  }

  if (verb === "list") {
    const granted = listTagHolders(tag);
    await ctx.reply(
      `**${tag}** — always: ${mentionList(getOwnerIds())}\n` +
        (granted.length > 0 ? `Granted: ${mentionList(granted)}` : "Nobody else has been granted it.")
    );
    return;
  }

  const userId = userArg && (await resolveUser(userArg, ctx.guildId));
  if (!userId) {
    await ctx.reply(userArg ? `Couldn't find a user "${userArg}" — try their user ID.` : USAGE);
    return;
  }

  if (verb === "add") {
    if (hasTag(userId, tag)) {
      await ctx.reply(`<@${userId}> already has **${tag}**.`);
      return;
    }
    addTag(userId, tag, ctx.userId);
    await ctx.reply(`Granted **${tag}** to <@${userId}>.`);
    return;
  }

  if (removeTag(userId, tag)) {
    await ctx.reply(`Removed **${tag}** from <@${userId}>.`);
    return;
  }
  await ctx.reply(
    hasTag(userId, tag)
      ? `<@${userId}> is a bot owner — owners always have **${tag}**.`
      : `<@${userId}> didn't have **${tag}**.`
  );
}
