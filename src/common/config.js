import dotenv from "dotenv";
dotenv.config();

function required(name) {
  return process.env[name] && process.env[name].trim() !== "" ? process.env[name].trim() : null;
}

// Bot-level config, shared by the persistent bot (bot.js) and command
// registration (deployCommands.js) — as opposed to per-feature config,
// which stays in each feature's own config.js.
export const config = {
  botToken: required("DISCORD_BOT_TOKEN"),
  clientId: required("DISCORD_CLIENT_ID"),
  // The "Orkus Info" channel — admin db commands only respond here. See
  // src/features/db/command.js.
  commandBoxChannelId: required("DISCORD_COMMAND_BOX"),
};
