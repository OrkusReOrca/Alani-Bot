// The persistent bot process — the "24/7" part of this repo. Everything
// else here (src/features/*) is one-off scheduled scripts triggered by
// GitHub Actions; this is the only thing that needs to stay running and
// connected, since slash commands require a live gateway connection to
// receive interactions. Run with `npm start`.
//
// Every command works two ways: as a slash command (/info) and as a prefix
// command (.a info) — both dispatch to the same command.js's execute(ctx),
// via the ctx-adapter each handler builds below, so a command never needs
// to know which one triggered it.
//
// New command checklist:
//   1. Add its command.js under src/features/<name>/ (see features/info/
//      for the shape: export `data` and `execute(ctx)`, where ctx exposes
//      `reply(text)`).
//   2. Register it in the `commands` map below.
//   3. Run `npm run deploy-commands` (only needed again when a command's
//      name/description/options change, not on every bot restart — this
//      step only affects the slash-command version; the prefix version
//      picks up new commands as soon as the bot restarts).

import { Client, Events, GatewayIntentBits } from "discord.js";
import { config } from "./common/config.js";
import * as infoCommand from "./features/info/command.js";

const commands = new Map([[infoCommand.data.name, infoCommand]]);

// ".a" must be its own token — "someword.a" or ".abc" shouldn't trigger it,
// only ".a" alone or ".a <command>".
const PREFIX = ".a";

if (!config.botToken) {
  console.error("Missing DISCORD_BOT_TOKEN — check your .env.");
  process.exit(1);
}

// MessageContent is a privileged intent — must also be turned on for this
// bot in the Discord Developer Portal (Bot tab -> "Message Content
// Intent"), or message.content will come through empty for every guild
// message and prefix commands silently never match.
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Alani is online as ${readyClient.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const command = commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute({ reply: (text) => interaction.reply(text) });
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

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (message.content !== PREFIX && !message.content.startsWith(`${PREFIX} `)) return;

  const commandName = message.content.slice(PREFIX.length).trim().split(/\s+/)[0]?.toLowerCase();
  const command = commands.get(commandName);
  if (!command) return;

  try {
    await command.execute({ reply: (text) => message.reply(text) });
  } catch (err) {
    console.error(`Error handling "${PREFIX} ${commandName}":`, err);
    await message.reply("Something went wrong running that command.").catch(() => {});
  }
});

client.login(config.botToken);
