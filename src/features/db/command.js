// ".a db [<database>] <add|list|delete|edit> [args...]" — admin-level
// access to Alani's structured data (reminders, calendar events, and
// whatever else lands in orkus-info or future databases). Two gates,
// checked in this order:
//
//   1. Channel: only responds inside the DISCORD_COMMAND_BOX channel
//      ("Orkus Info") — silently ignored for non-owners everywhere else,
//      same as any unrecognized prefix command, so it doesn't advertise
//      its existence to anyone it's not for. For an OWNER in the wrong
//      channel, though, silence is just undebuggable — they get told
//      exactly what's configured vs. where they are instead (this is
//      what motivated the check order below: owner status has to be known
//      before deciding whether "wrong channel" should reply or stay quiet).
//   2. Owner: only DISCORD_OWNER_0 / DISCORD_OWNER_1 (see
//      src/common/auth.js) — anyone else gets an explicit "Unauthorized
//      user, no permission" reply, since at this point they ARE in the
//      right channel and should know the command exists but isn't for them.
//
// Prefix-only — not registered as a slash command, both because it takes
// freeform args (dates, freeform text) that don't map onto slash command
// options cleanly, and because admin commands living outside Discord's
// command picker/autocomplete is a mild extra layer of obscurity.
//
// Database resolution: `<database>` is optional and defaults to
// DEFAULT_DATABASE (orkus-info) — see registry.js. If the first arg after
// "db" matches a registered database name, it's used as the target
// instead and the rest of the args shift over by one. New databases
// (email, etc.) plug in below via register(name, handlers) — see
// src/features/orkus-info/actions.js for the handler shape.

import { config } from "../../common/config.js";
import { isOwner } from "../../common/auth.js";
import { register, get as getDatabase, names as databaseNames, DEFAULT_DATABASE } from "./registry.js";
import orkusInfo from "../orkus-info/actions.js";

register(DEFAULT_DATABASE, orkusInfo);

export const data = {
  name: "db",
};

function usage() {
  return [
    "Usage: `.a db [<database>] <add|list|delete|edit> [args...]`",
    `Databases: ${databaseNames().join(", ")} (defaults to \`${DEFAULT_DATABASE}\` if omitted)`,
  ].join("\n");
}

export async function execute(ctx, args = []) {
  const owner = isOwner(ctx.userId);

  if (ctx.channelId !== config.commandBoxChannelId) {
    // Stay silent to non-owners regardless of channel — don't reveal this
    // command exists to anyone it's not for. But silence to an OWNER here
    // is just an undebuggable dead end (wrong channel? DISCORD_COMMAND_BOX
    // not actually set? bot not restarted since it was set?) — tell them
    // exactly what's configured vs. where they are.
    if (owner) {
      await ctx.reply(
        `\`.a db\` only works in the Orkus Info channel. DISCORD_COMMAND_BOX is currently ` +
          `${config.commandBoxChannelId ? `\`${config.commandBoxChannelId}\`` : "**not set**"}, this channel is \`${ctx.channelId}\`.`
      );
    }
    return;
  }

  if (!owner) {
    await ctx.reply("Unauthorized user, no permission");
    return;
  }

  if (args.length === 0) {
    await ctx.reply(usage());
    return;
  }

  let dbName = DEFAULT_DATABASE;
  let rest = args;
  if (databaseNames().includes(args[0].toLowerCase())) {
    dbName = args[0].toLowerCase();
    rest = args.slice(1);
  }

  const database = getDatabase(dbName);
  if (!database) {
    await ctx.reply(`Unknown database "${dbName}". Available: ${databaseNames().join(", ")}`);
    return;
  }

  const [action, ...actionArgs] = rest;
  const handler = action && database[action.toLowerCase()];
  if (typeof handler !== "function") {
    await ctx.reply(usage());
    return;
  }

  const reply = await handler(actionArgs, ctx);
  await ctx.reply(reply);
}
