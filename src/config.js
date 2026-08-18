import dotenv from "dotenv";
dotenv.config();

function required(name) {
  return process.env[name] && process.env[name].trim() !== "" ? process.env[name].trim() : null;
}

export const config = {
  webhookUrl: required("DISCORD_WEBHOOK_URL"),
  botToken: required("DISCORD_BOT_TOKEN"),
  userId: required("DISCORD_USER_ID"),
  channelId: required("DISCORD_CHANNEL_ID"),
};
