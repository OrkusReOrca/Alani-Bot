import dotenv from "dotenv";
dotenv.config();

function required(name) {
  return process.env[name] && process.env[name].trim() !== "" ? process.env[name].trim() : null;
}

export const config = {
  botToken: required("DISCORD_BOT_TOKEN"),
  channelId: required("DISCORD_FORTNITE_CHANNEL_ID"),
};
