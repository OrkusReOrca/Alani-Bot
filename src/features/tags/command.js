// ".a tag ..." — owner-only.
//
//   .a tag list                    every tag and what it unlocks
//   .a tag <TAG> list              who holds that tag      (also: .a tag list <TAG>)
//   .a tag add <TAG> <user>        grant
//   .a tag remove <TAG> <user>     revoke
//
// <user> is a user ID, an @mention, or a username (looked up in the current
// server). See store.js for what tags exist.

import { isOwner, getOwnerIds } from "../../common/auth.js";
import { resolveMentions } from "../../common/mentions.js";
import { TAG_DEFINITIONS, canonicalTag, hasTag, addTag, removeTag, listTagHolders } from "./store.js";

export const data = {
  name: "tag",
};

const TAG_NAMES = Object.keys(TAG_DEFINITIONS);

export const aiGuide = `
.a tag list                  — every tag and what it unlocks (owner only)
.a tag <tag> list            — who holds a tag (owner only)
.a tag add <tag> <user>      — grant a tag (owner only)
.a tag remove <tag> <user>   — revoke a tag (owner only)
Tags:
${TAG_NAMES.map((name) => `- ${name}: ${TAG_DEFINITIONS[name]}`).join("\n")}
Bot owners always hold every tag. <user> is a user ID, an <@id> mention, or a username.`;

export const isDestructive = (args) => args[0]?.toLowerCase() === "remove";

const USAGE = [
  "Usage:",
  "`.a tag list` — every tag and what it unlocks",
  `\`.a tag <${TAG_NAMES.join("|")}> list\` — who holds it`,
  `\`.a tag add|remove <${TAG_NAMES.join("|")}> <user>\``,
].join("\n");

const mentionList = (ids) => ids.map((id) => `<@${id}>`).join(" ");

async function resolveUser(token, guildId) {
  const id = /^<@!?(\d+)>$/.exec(token)?.[1] ?? token;
  const { resolved } = await resolveMentions(id, guildId);
  return resolved[0] ?? null;
}

function describeAllTags() {
  return ["**Tags**", ...TAG_NAMES.map((name) => `• **${name}** — ${TAG_DEFINITIONS[name]}`), "", "Bot owners hold every tag."].join("\n");
}

function describeHolders(tag) {
  const granted = listTagHolders(tag);
  return `**${tag}** — always (bot owners): ${mentionList(getOwnerIds())}\n${granted.length > 0 ? `Granted: ${mentionList(granted)}` : "Nobody else has been granted it."}`;
}

async function handleChange(verb, tag, userArg, ctx) {
  const userId = userArg && (await resolveUser(userArg, ctx.guildId));
  if (!userId) return userArg ? `Couldn't find a user "${userArg}" — try their user ID.` : USAGE;

  if (verb === "add") {
    if (hasTag(userId, tag)) return `<@${userId}> already has **${tag}**.`;
    addTag(userId, tag, ctx.userId);
    return `Granted **${tag}** to <@${userId}>.`;
  }

  if (removeTag(userId, tag)) return `Removed **${tag}** from <@${userId}>.`;
  return hasTag(userId, tag) ? `<@${userId}> is a bot owner — owners always have **${tag}**.` : `<@${userId}> didn't have **${tag}**.`;
}

export async function execute(ctx, args = []) {
  if (!isOwner(ctx.userId)) {
    await ctx.reply("Unauthorized user, no permission");
    return;
  }

  const [first, second, third] = args;
  const verb = first?.toLowerCase();

  if (verb === "list" && !second) return void (await ctx.reply(describeAllTags()));

  // ".a tag list <TAG>" and ".a tag <TAG> list" both show the holders.
  const holdersOf = verb === "list" ? canonicalTag(second) : second?.toLowerCase() === "list" ? canonicalTag(first) : null;
  if (holdersOf) return void (await ctx.reply(describeHolders(holdersOf)));

  const tag = canonicalTag(second);
  if (["add", "remove"].includes(verb) && tag) return void (await ctx.reply(await handleChange(verb, tag, third, ctx)));

  await ctx.reply(USAGE);
}
