// One-off (or run-again-when-commands-change) registration of this bot's
// slash commands with Discord. Separate from bot.js on purpose: the
// persistent bot shouldn't hit Discord's REST API to re-register commands
// on every restart — this only needs running once, and again whenever a
// command's name/description/options actually change.
//
//   npm run deploy-commands

import { REST, Routes } from "discord.js";
import { config } from "./common/config.js";
import { data as infoCommand } from "./features/info/command.js";

const commands = [infoCommand];

if (!config.botToken || !config.clientId) {
  console.error("Missing DISCORD_BOT_TOKEN or DISCORD_CLIENT_ID — check your .env.");
  process.exit(1);
}

const rest = new REST({ version: "10" }).setToken(config.botToken);

try {
  console.log(`Registering ${commands.length} slash command(s): ${commands.map((c) => c.name).join(", ")}`);
  await rest.put(Routes.applicationCommands(config.clientId), { body: commands });
  console.log("Done.");
} catch (err) {
  console.error("Failed to register commands:", err);
  process.exit(1);
}
