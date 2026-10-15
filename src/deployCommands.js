// Manual registration of this bot's slash commands with Discord (`npm run deploy-commands`). The bot also
// does this by itself at start-up whenever the commands changed (see slashCommands.js), so this is only
// needed to force it.

import { config } from "./common/config.js";
import { commands } from "./commands.js";
import { buildSlashBody, registerSlashCommands } from "./slashCommands.js";

if (!config.botToken || !config.clientId) {
  console.error("Missing DISCORD_BOT_TOKEN or DISCORD_CLIENT_ID — check your .env.");
  process.exit(1);
}

try {
  const names = buildSlashBody(commands).map((c) => c.name);
  console.log(`Registering ${names.length} slash command(s): ${names.join(", ")}`);
  await registerSlashCommands({ commands, token: config.botToken, clientId: config.clientId });
  console.log("Done.");
} catch (err) {
  console.error("Failed to register commands:", err);
  process.exit(1);
}
