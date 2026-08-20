// The persistent bot process — the "24/7" part of this repo. Everything
// else here (src/features/*) is one-off scheduled scripts triggered by
// GitHub Actions; this is the only thing that needs to stay running and
// connected, since slash commands require a live gateway connection to
// receive interactions. Run with `npm start`.
//
// New slash command checklist:
//   1. Add its command.js under src/features/<name>/ (see features/info/
//      for the shape: export `data` and `execute`).
//   2. Register it in the `commands` map below.
//   3. Run `npm run deploy-commands` (only needed again when a command's
//      name/description/options change, not on every bot restart).

import { Client, Events, GatewayIntentBits } from "discord.js";
import { config } from "./common/config.js";
import * as infoCommand from "./features/info/command.js";

const commands = new Map([[infoCommand.data.name, infoCommand]]);

if (!config.botToken) {
  console.error("Missing DISCORD_BOT_TOKEN — check your .env.");
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Alani is online as ${readyClient.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const command = commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction);
  } catch (err) {
    console.error(`Error handling /${interaction.commandName}:`, err);
    const payload = { content: "Something went wrong running that command.", ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(payload);
    } else {
      await interaction.reply(payload);
    }
  }
});

client.login(config.botToken);
