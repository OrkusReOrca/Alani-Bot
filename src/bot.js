// The persistent bot process — the "24/7" part of this repo. Everything
// else here (src/features/*) is one-off scheduled scripts triggered by
// GitHub Actions; this is the only thing that needs to stay running and
// connected, since slash commands require a live gateway connection to
// receive interactions. Run with `npm start`.
//
// Every command is reachable as a prefix command (.a <name> [args...]),
// dispatched to command.js's execute(ctx, args) via the ctx-adapter each
// handler builds below. Commands that also have a `description` are
// additionally registered as slash commands (/name) — see
// deployCommands.js — since a slash command needs a single-word name and
// doesn't take freeform args the way "fjamtrack shop" does.
//
// New command checklist:
//   1. Add its command.js under src/features/<name>/ (see features/info/
//      for the shape: export `data` — needs at least `name`, plus
//      `description` if it should also be a slash command — and
//      `execute(ctx, args)`, where ctx exposes `reply(text)` and
//      `replyWithFile(buffer, filename)`).
//   2. Register it in the `commands` map below.
//   3. If it has a `description` (i.e. it's also a slash command), run
//      `npm run deploy-commands` (only needed again when a command's
//      name/description/options change, not on every bot restart). Prefix
//      commands need no registration — they work as soon as the bot
//      restarts with the new code.

import { Client, Events, GatewayIntentBits } from "discord.js";
import { config } from "./common/config.js";
import * as infoCommand from "./features/info/command.js";
import * as fjamtrackCommand from "./features/fortnite-jam-tracks-tracker/shop/command.js";

const commands = new Map([
  [infoCommand.data.name, infoCommand],
  [fjamtrackCommand.data.name, fjamtrackCommand],
]);

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

  const ctx = {
    reply: (text) => interaction.reply(text),
    replyWithFile: (buffer, filename) => interaction.reply({ files: [{ attachment: buffer, name: filename }] }),
  };

  try {
    await command.execute(ctx, []);
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

  const tokens = message.content.slice(PREFIX.length).trim().split(/\s+/).filter(Boolean);
  const commandName = tokens[0]?.toLowerCase();
  const args = tokens.slice(1);
  const command = commands.get(commandName);
  if (!command) return;

  const ctx = {
    reply: (text) => message.reply(text),
    replyWithFile: (buffer, filename) => message.reply({ files: [{ attachment: buffer, name: filename }] }),
  };

  try {
    await command.execute(ctx, args);
  } catch (err) {
    console.error(`Error handling "${PREFIX} ${commandName}":`, err);
    await message.reply("Something went wrong running that command.").catch(() => {});
  }
});

client.login(config.botToken);
