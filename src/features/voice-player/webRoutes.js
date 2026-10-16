// Puts the web app's music API (webApi.js) on the bridge server, wired to the real player, Discord and
// storage. Off unless ALANI_WEB_API_SECRET is set (the same value as the Alani web service's).

import { readEnv } from "../../common/env.js";
import { getClient } from "../../common/discordClient.js";
import { createWebMusicApi } from "./webApi.js";
import { audioCache, getSession, prepareVoice } from "./manager.js";
import { listPlayableFiles } from "./library.js";
import { guildsUsedBy, loadState, noteGuildUser, personalQueueId, playHistory, recordPlay, saveState } from "./stateStore.js";

export function registerWebMusicRoutes(registerRoute) {
  const secret = readEnv("ALANI_WEB_API_SECRET");
  if (!secret) return;
  const handle = createWebMusicApi({
    discord: getClient,
    getSession,
    prepareVoice,
    audioCache,
    listPlayableFiles,
    store: { loadState, saveState, guildsUsedBy, noteGuildUser, playHistory, recordPlay, personalQueueId },
  });
  registerRoute("GET", "/web/music/*", secret, handle);
  registerRoute("POST", "/web/music/*", secret, handle);
}
