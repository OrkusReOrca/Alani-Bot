import { readEnv } from "../../common/env.js";

export const config = {
  // ".a emo ..." only responds in this one channel — same idea as
  // DISCORD_COMMAND_BOX for ".a db", just its own dedicated channel since
  // this feature has nothing to do with the db tier system.
  channelId: readEnv("DISCORD_EMOTION_CHANNEL"),
  // The "Alani Emotion" Python service's own bot-hosting.net address
  // (its Network tab, same as VOICE_API_PORT's own setup) + the shared
  // secret both sides check. One secret authenticates both directions
  // (Alani-Bot -> service to start a run, service -> Alani-Bot's bridge
  // routes to report a result) since they're the same trust boundary —
  // unlike the voice bridge/uni-tracker-push split, there's no third
  // party here that should only reach one direction.
  serviceUrl: readEnv("EMOTION_SERVICE_URL"),
  serviceSecret: readEnv("EMOTION_SERVICE_SECRET"),
};
