// ".a db [<database>] <verb> [args...]" — permission is now PER-DATABASE,
// not one flat gate. Three tiers:
//
//   - Main (Orkus Info): only DISCORD_OWNER_0/1, only inside the
//     DISCORD_COMMAND_BOX channel — exactly the bot's original single
//     database, unchanged. This is Main's own rule, not a blanket rule
//     other databases inherit.
//   - Tier Personal: an owner-granted user can create ONE private
//     "general-user-db" (`.a db create personal <name> <channel|dm>`),
//     usable in ANY channel, visible only to them + bot owners.
//   - Tier Server: an owner-granted user can create ONE guild-scoped
//     "general-server-db" (`.a db create server <name> <channel|dm>`),
//     usable in ANY channel, visible to them + collaborators they add +
//     bot owners. Its events also mirror to a real Discord Scheduled
//     Event in that guild — see general-server-db/actions.js.
//
// Bot owners (DISCORD_OWNER_0/1) can reach every database, every tier,
// always — including frozen ones (see below), which nobody else can.
//
// "Frozen": revoking a tier doesn't delete that user's database — it
// freezes it (fully inaccessible to anyone but a bot owner) until either
// the tier is re-granted (auto-unfreezes databases that user OWNS — not
// ones they merely collaborate on) or a bot owner runs `.a db transfer`
// to reassign ownership. See src/features/db/store.js.
//
// Database resolution, checked in this order:
//   1. A reserved top-level verb (grant/revoke/create/drop/collab/
//      transfer) — handled directly, independent of any specific
//      database, usable in any channel.
//   2. "main" or "orkus-info" — targets Main tier.
//   3. Otherwise, matched against databases the caller can currently
//      reach (owns, collaborates on, or — for bot owners — every
//      database including frozen ones). No match / no name given: if
//      exactly one is reachable (counting Main only when the caller's an
//      owner standing in the command-box channel), that's used
//      automatically; zero or multiple always requires being explicit
//      rather than guessing.
//
// See src/features/db/README.md for the full command list and the
// reasoning above in more detail.

import { config } from "../../common/config.js";
import { isOwner } from "../../common/auth.js";
import { canSendInChannel } from "../../common/channelAccess.js";
import { getClient } from "../../common/discordClient.js";
import { register, get as getDatabase } from "./registry.js";
import * as store from "./store.js";
import orkusInfo from "../orkus-info/actions.js";
import generalUserDb from "../general-user-db/actions.js";
import generalServerDb from "../general-server-db/actions.js";

register("orkus-info", orkusInfo);
register("general-user-db", generalUserDb);
register("general-server-db", generalServerDb);

const SNOWFLAKE_RE = /^\d{15,20}$/;

export const data = {
  name: "db",
};

function usage() {
  return [
    "Usage: `.a db [<database>] <add|list|delete|edit> [args...]`",
    "Tier admin: `.a db grant|revoke <personal|server> <user-id>` (bot owner only)",
    "Create/manage: `.a db create <personal|server> <name> <channel-id|dm>` · `.a db drop <name>` · `.a db collab add|remove <name> <user-id>` (server-kind only)",
    "`.a db transfer <name> <new-owner-id>` (bot owner only — un-freezes and reassigns)",
  ].join("\n");
}

// ---------- reserved-verb handlers (no specific database involved) ----------

async function handleGrant(args, ctx, revoke) {
  if (!isOwner(ctx.userId)) return "Unauthorized user, no permission";
  const [tier, userId] = args;
  if (!["personal", "server"].includes(tier) || !SNOWFLAKE_RE.test(userId ?? "")) {
    return `Usage: \`.a db ${revoke ? "revoke" : "grant"} <personal|server> <user-id>\``;
  }
  const logCtx = { channelId: ctx.channelId, guildId: ctx.guildId };
  if (revoke) {
    const had = store.revokeTier(userId, tier, ctx.userId, logCtx);
    return had
      ? `Revoked Tier ${tier === "personal" ? "Personal" : "Server"} from <@${userId}> — any database(s) they own are now frozen (inaccessible except to bot owners) until re-granted or transferred.`
      : `<@${userId}> didn't have Tier ${tier === "personal" ? "Personal" : "Server"}.`;
  }
  store.grantTier(userId, tier, ctx.userId, logCtx);
  return `Granted Tier ${tier === "personal" ? "Personal" : "Server"} to <@${userId}>.`;
}

async function handleCreate(args, ctx) {
  const [tierArg, name, channelArg] = args;
  const kind = tierArg === "personal" ? "user" : tierArg === "server" ? "server" : null;
  const tier = tierArg === "personal" ? "personal" : tierArg === "server" ? "server" : null;
  if (!kind || !name || !channelArg) {
    return "Usage: `.a db create <personal|server> <name> <channel-id|dm>`";
  }
  if (!isOwner(ctx.userId) && !store.hasGrant(ctx.userId, tier)) {
    return `You need Tier ${tierArg === "personal" ? "Personal" : "Server"} to do that — ask a bot owner to grant it.`;
  }
  if (store.isReservedName(name)) {
    return `"${name}" is a reserved word — pick a different database name.`;
  }
  if (store.getDatabaseByName(name, ctx.userId, { includeAll: true })) {
    return `The name "${name}" is already taken — pick a different one.`;
  }
  if (store.countOwnedDatabases(ctx.userId, kind) > 0) {
    return `You already have a ${tierArg} database — \`.a db drop <name>\` it first if you want a different one.`;
  }
  if (kind === "server" && !ctx.guildId) {
    return "`.a db create server` has to be run inside the server you want the database scoped to, not a DM.";
  }

  let primaryChannelId = channelArg;
  if (channelArg.toLowerCase() === "dm") {
    primaryChannelId = "dm";
  } else if (SNOWFLAKE_RE.test(channelArg)) {
    const client = getClient();
    let channel;
    try {
      channel = await client.channels.fetch(channelArg);
    } catch {
      channel = null;
    }
    if (!(await canSendInChannel(client, channel))) {
      return `Can't send in channel \`${channelArg}\` — check the ID and that Alani has permission to post there.`;
    }
    if (kind === "server" && channel.guildId !== ctx.guildId) {
      return "The primary channel for a server database has to belong to this same server.";
    }
  } else {
    return "Primary channel must be a channel ID or the literal word `dm`.";
  }

  // guildId is captured for BOTH kinds now (not just server-kind) — purely
  // informational for a personal db (it isn't restricted to that guild the
  // way a server db is), but needed so `.a list db` run inside a guild can
  // show "user databases created here" alongside that guild's server dbs.
  const instance = store.createDatabase({
    kind,
    name,
    ownerUserId: ctx.userId,
    guildId: ctx.guildId,
    primaryChannelId,
    channelId: ctx.channelId,
  });
  return `Created ${tierArg} database "${instance.name}" — primary destination: ${primaryChannelId === "dm" ? "DM" : `<#${primaryChannelId}>`}. Use it via \`.a db ${instance.name} ...\`.`;
}

async function handleDrop(args, ctx) {
  const [name] = args;
  if (!name) return "Usage: `.a db drop <name>`";
  const instance = store.getDatabaseByName(name, ctx.userId, { includeAll: isOwner(ctx.userId) });
  if (!instance) return `No database "${name}" you have access to.`;
  if (!isOwner(ctx.userId) && instance.owner_user_id !== ctx.userId) {
    return "Only that database's owner (or a bot owner) can drop it.";
  }
  store.dropDatabase(instance.id);
  return `Dropped database "${instance.name}" and everything in it.`;
}

async function handleCollab(args, ctx) {
  const [action, name, userId] = args;
  if (!["add", "remove"].includes(action) || !name || !SNOWFLAKE_RE.test(userId ?? "")) {
    return "Usage: `.a db collab <add|remove> <name> <user-id>`";
  }
  const instance = store.getDatabaseByName(name, ctx.userId, { includeAll: isOwner(ctx.userId) });
  if (!instance) return `No database "${name}" you have access to.`;
  if (instance.kind !== "server") return "Collaborators only apply to server-tier databases.";
  if (!isOwner(ctx.userId) && instance.owner_user_id !== ctx.userId) {
    return "Only that database's owner (or a bot owner) can manage its collaborators.";
  }
  const logCtx = { channelId: ctx.channelId, guildId: ctx.guildId };
  if (action === "add") {
    store.addCollaborator(instance.id, userId, ctx.userId, logCtx);
    return `Added <@${userId}> as a collaborator on "${instance.name}".`;
  }
  const removed = store.removeCollaborator(instance.id, userId, ctx.userId, logCtx);
  return removed ? `Removed <@${userId}> from "${instance.name}".` : `<@${userId}> wasn't a collaborator on "${instance.name}".`;
}

async function handleTransfer(args, ctx) {
  if (!isOwner(ctx.userId)) return "Unauthorized user, no permission";
  const [name, newOwnerId] = args;
  if (!name || !SNOWFLAKE_RE.test(newOwnerId ?? "")) return "Usage: `.a db transfer <name> <new-owner-id>`";
  const instance = store.getDatabaseByName(name, ctx.userId, { includeAll: true });
  if (!instance) return `No database "${name}".`;
  store.transferOwnership(instance.id, newOwnerId, ctx.userId, { channelId: ctx.channelId, guildId: ctx.guildId });
  return `"${instance.name}" is now owned by <@${newOwnerId}> (and un-frozen, if it was).`;
}

const RESERVED_VERB_HANDLERS = {
  grant: (args, ctx) => handleGrant(args, ctx, false),
  revoke: (args, ctx) => handleGrant(args, ctx, true),
  create: handleCreate,
  drop: handleDrop,
  collab: handleCollab,
  transfer: handleTransfer,
};

// ---------- database resolution + dispatch ----------

function registryNameForKind(kind) {
  return kind === "user" ? "general-user-db" : "general-server-db";
}

export async function execute(ctx, args = []) {
  if (args.length === 0) {
    await ctx.reply(usage());
    return;
  }

  const first = args[0].toLowerCase();

  const reservedHandler = RESERVED_VERB_HANDLERS[first];
  if (reservedHandler) {
    await ctx.reply(await reservedHandler(args.slice(1), ctx));
    return;
  }

  // ---- Main (Orkus Info) ----
  if (first === "main" || first === "orkus-info") {
    await dispatchMain(args.slice(1), ctx);
    return;
  }

  // ---- resolve against reachable general-user-db / general-server-db instances ----
  const owner = isOwner(ctx.userId);
  // Two different lookups on purpose: EXPLICIT name matching lets a bot
  // owner reach any database in the bot by name (includeAll), but the
  // IMPLICIT "no name given, is there only one option" fallback must only
  // ever consider databases this specific caller actually owns/
  // collaborates on — otherwise a bot owner would get "multiple databases
  // accessible" the moment ANY other user's database exists at all,
  // breaking the common case of an owner just using Main with no name.
  const allReachableByName = store.listAccessibleDatabases(ctx.userId, { includeAll: owner });
  const ownCandidates = owner ? store.listAccessibleDatabases(ctx.userId, { includeAll: false }) : allReachableByName;
  const mainReachable = owner && ctx.channelId === config.commandBoxChannelId;

  const named = allReachableByName.find((d) => d.name.toLowerCase() === first);
  if (named) {
    await dispatchInstance(named, args.slice(1), ctx);
    return;
  }

  const candidateNames = [...ownCandidates.map((d) => d.name), ...(mainReachable ? ["main"] : [])];
  if (candidateNames.length === 0) {
    await ctx.reply("You don't have access to any database here.");
    return;
  }
  if (candidateNames.length > 1) {
    await ctx.reply(`Multiple databases accessible: ${candidateNames.join(", ")} — specify one: \`.a db <name> <verb> ...\``);
    return;
  }

  // Exactly one candidate and no name was given (or it just didn't match
  // anything) — auto-select it.
  if (candidateNames[0] === "main") {
    await dispatchMain(args, ctx);
  } else {
    await dispatchInstance(ownCandidates[0], args, ctx);
  }
}

async function dispatchMain(rest, ctx) {
  const owner = isOwner(ctx.userId);
  if (ctx.channelId !== config.commandBoxChannelId) {
    if (owner) {
      await ctx.reply(
        `\`.a db main\` only works in the Orkus Info channel. DISCORD_COMMAND_BOX is currently ` +
          `${config.commandBoxChannelId ? `\`${config.commandBoxChannelId}\`` : "**not set**"}, this channel is \`${ctx.channelId}\`.`
      );
    }
    return;
  }
  if (!owner) {
    await ctx.reply("Unauthorized user, no permission");
    return;
  }
  await runVerb(getDatabase("orkus-info"), rest, ctx, null);
}

async function dispatchInstance(instance, rest, ctx) {
  const database = getDatabase(registryNameForKind(instance.kind));
  await runVerb(database, rest, ctx, instance);
}

async function runVerb(database, rest, ctx, instance) {
  const [action, ...actionArgs] = rest;
  const handler = action && database?.[action.toLowerCase()];
  if (typeof handler !== "function") {
    await ctx.reply(usage());
    return;
  }
  const reply = await handler(actionArgs, ctx, instance);
  await ctx.reply(reply);
}
