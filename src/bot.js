// The persistent bot process — the "24/7" part of this repo. This is the
// only thing that needs to stay running and connected, since slash
// commands require a live gateway connection to receive interactions.
// Run with `npm start`.
//
// uni-application-updater's daily job runs on an in-process timer now —
// see common/dailyJobs.js — instead of GitHub Actions cron, since this
// bot is online 24/7 and doesn't need to wait on GitHub's Actions queue
// (which was seen running 30-48+ minutes late). fortnite-jam-tracks-
// tracker's shop check/post was tried the same way and reverted back to
// GitHub Actions — its post step needs the `canvas` native module, which
// bot-hosting.net's script policy blocks from building (see
// common/dailyJobs.js's comment for the full story).
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
//      `execute(ctx, args)`, where ctx exposes `reply(text)`,
//      `replyWithFile(buffer, filename)`, `userId`, `channelId`, and
//      `guildId`).
//   2. Register it in the `commands` map below.
//   3. If it has a `description` (i.e. it's also a slash command), run
//      `npm run deploy-commands` (only needed again when a command's
//      name/description/options change, not on every bot restart). Prefix
//      commands need no registration — they work as soon as the bot
//      restarts with the new code.

import { Client, Events, GatewayIntentBits } from "discord.js";
import { config } from "./common/config.js";
import { setClient } from "./common/discordClient.js";
import * as infoCommand from "./features/info/command.js";
import * as fjamtrackCommand from "./features/fortnite-jam-tracks-tracker/shop/command.js";
import * as dbCommand from "./features/db/command.js";
import * as listDbCommand from "./features/db/listDbCommand.js";
import { startReminderScheduler } from "./features/orkus-info/scheduler.js";
import { startGenReminderScheduler } from "./features/db/scheduler.js";
import { startBridgeServer } from "./common/bridgeServer.js";
import { startDailyJobs } from "./common/dailyJobs.js";

const commands = new Map([
  [infoCommand.data.name, infoCommand],
  [fjamtrackCommand.data.name, fjamtrackCommand],
  [dbCommand.data.name, dbCommand],
  [listDbCommand.data.name, listDbCommand],
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

setClient(client);

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Alani is online as ${readyClient.user.tag}`);
  // Needs a fully logged-in client (DM channel creation, channel
  // fetches) — starting it here rather than at module load.
  startReminderScheduler();
  startGenReminderScheduler();
  startBridgeServer();
  startDailyJobs();
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const command = commands.get(interaction.commandName);
  if (!command) return;

  const ctx = {
    reply: (text) => interaction.reply(text),
    replyWithFile: (buffer, filename) => interaction.reply({ files: [{ attachment: buffer, name: filename }] }),
    userId: interaction.user.id,
    channelId: interaction.channelId,
    guildId: interaction.guildId, // null in DMs
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
    userId: message.author.id,
    channelId: message.channelId,
    guildId: message.guildId, // null in DMs
  };

  try {
    await command.execute(ctx, args);
  } catch (err) {
    console.error(`Error handling "${PREFIX} ${commandName}":`, err);
    await message.reply("Something went wrong running that command.").catch(() => {});
  }
});

client.login(config.botToken);
