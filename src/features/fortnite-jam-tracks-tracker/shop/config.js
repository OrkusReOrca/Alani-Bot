import { readEnv } from "../../../common/env.js";

export const config = {
  botToken: readEnv("DISCORD_BOT_TOKEN"),
  channelId: readEnv("DISCORD_FORTNITE_CHANNEL_ID"),
};
