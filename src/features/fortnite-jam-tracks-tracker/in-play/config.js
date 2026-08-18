import dotenv from "dotenv";
dotenv.config();

function required(name) {
  return process.env[name] && process.env[name].trim() !== "" ? process.env[name].trim() : null;
}

// Same bot + same channel as the shop sub-feature — this posts right
// after that daily update, in the same channel.
export const config = {
  botToken: required("DISCORD_BOT_TOKEN"),
  channelId: required("DISCORD_FORTNITE_CHANNEL_ID"),
};
