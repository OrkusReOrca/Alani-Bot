import dotenv from "dotenv";
dotenv.config();

function required(name) {
  return process.env[name] && process.env[name].trim() !== "" ? process.env[name].trim() : null;
}

export const config = {
  botToken: required("DISCORD_BOT_TOKEN"),
  userId: required("DISCORD_USER_ID"),
  channelId: required("DISCORD_CHANNEL_ID"),
  // Auth for pushApi.js's /admin/uni-programs route — separate secret
  // from voice-Alani's VOICE_API_SECRET since this is a different holder
  // (whatever runs the research routine) and a different blast radius
  // (can only overwrite this one JSON file, not touch reminders/db).
  pushSecret: required("UNI_TRACKER_PUSH_SECRET"),
};
