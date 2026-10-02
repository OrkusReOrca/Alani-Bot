// The real-world wiring of the voice player: one session per server (created on
// first use), sharing one audio cache. The cache needs ffmpeg, which is an
// optional dependency, so it's created on first need and its absence only
// breaks actual playback.

import { config as botConfig } from "../../common/config.js";
import { sendViaBotChannel } from "../../common/discordApi.js";
import { downloadStream } from "../../common/googleDrive.js";
import { config, limits } from "./config.js";
import { createAudioCache } from "./audioCache.js";
import { createDiscordOutput } from "./discordOutput.js";
import { createGuildSession } from "./session.js";
import { loadState, saveState } from "./stateStore.js";
import { getSetting } from "../settings/store.js";
import { ON, PLAY_CALL_KEY } from "../settings/definitions.js";

let cache = null;
const sessions = new Map(); // guildId -> { session, textChannelId }

async function createCache() {
  let ffmpegPath;
  try {
    ffmpegPath = (await import("@ffmpeg-installer/ffmpeg")).default.path;
  } catch (err) {
    throw new Error(`ffmpeg isn't available on this host (${err.message.split("\n")[0]})`);
  }
  return createAudioCache({
    dir: config.cacheDir,
    maxBytes: limits.cacheMaxBytes,
    bitrate: limits.opusBitrate,
    ffmpegPath,
    download: downloadStream,
  });
}

// Makes sure the cache exists (throws a readable error if ffmpeg is missing).
export async function prepareVoice() {
  cache ??= await createCache();
}

function getCache() {
  if (!cache) throw new Error("the audio cache isn't ready — voice playback is unavailable");
  return cache;
}

export function getSession(guildId) {
  let entry = sessions.get(guildId);
  if (!entry) {
    entry = { textChannelId: null };
    entry.session = createGuildSession({
      guildId,
      store: { loadState, saveState },
      getCache,
      output: createDiscordOutput({ guildId }),
      announce: (text) => {
        if (!entry.textChannelId) return;
        sendViaBotChannel(botConfig.botToken, entry.textChannelId, text).catch((err) => console.error("[voice-player] announce failed:", err));
      },
      announceNowPlaying: () => getSetting(PLAY_CALL_KEY) === ON,
      timing: limits,
    });
    sessions.set(guildId, entry);
  }
  return entry.session;
}

// Where "Now playing" messages go: the text channel of the latest command.
export function setTextChannel(guildId, channelId) {
  getSession(guildId);
  sessions.get(guildId).textChannelId = channelId;
}

// For the bot's voiceStateUpdate event: re-check whether the bot is alone.
export function onVoiceActivity(guildId) {
  sessions.get(guildId)?.session.evaluateCompany();
}
