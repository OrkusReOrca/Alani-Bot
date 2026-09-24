import { readEnv } from "../../common/env.js";

export const config = {
  botToken: readEnv("DISCORD_BOT_TOKEN"),
  userId: readEnv("DISCORD_USER_ID"),
  channelId: readEnv("DISCORD_CHANNEL_ID"),
  // Auth for pushApi.js's /admin/uni-programs route — separate secret
  // from voice-Alani's VOICE_API_SECRET since this is a different holder
  // (whatever runs the research routine) and a different blast radius
  // (can only overwrite this one JSON file, not touch reminders/db).
  pushSecret: readEnv("UNI_TRACKER_PUSH_SECRET"),
};
