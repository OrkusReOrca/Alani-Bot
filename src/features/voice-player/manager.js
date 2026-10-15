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
import { listGuildsInCall, listGuildsWithQueue, loadPresence, loadState, savePresence, saveState } from "./stateStore.js";

let cache = null;
const sessions = new Map(); // guildId -> { session, textChannelId }
let shuttingDown = false;

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
    entry = { textChannelId: loadPresence(guildId).textChannelId };
    entry.session = createGuildSession({
      guildId,
      store: { loadState, saveState },
      getCache,
      output: createDiscordOutput({ guildId }),
      announce: (text) => {
        if (!entry.textChannelId) return;
        sendViaBotChannel(botConfig.botToken, entry.textChannelId, text).catch((err) => console.error("[voice-player] announce failed:", err));
      },
      timing: limits,
      presence: {
        connected: (channelId) => savePresence(guildId, { voiceChannelId: channelId }),
        // Closing the connections on shutdown must not look like leaving: the bot rejoins after the restart.
        disconnected: () => {
          if (!shuttingDown) savePresence(guildId, { voiceChannelId: null });
        },
      },
    });
    sessions.set(guildId, entry);
  }
  return entry.session;
}

// Where "Now playing" messages go: the text channel of the latest command.
export function setTextChannel(guildId, channelId) {
  getSession(guildId);
  const entry = sessions.get(guildId);
  if (entry.textChannelId === channelId) return;
  entry.textChannelId = channelId;
  savePresence(guildId, { textChannelId: channelId });
}

// Called just before the bot closes its Discord connection on purpose.
export function markShuttingDown() {
  shuttingDown = true;
}

// After the bot starts: gets the audio cache ready, re-converts what is queued, and rejoins every call
// the bot was in when it stopped (the queue is resumed from the start of the current track).
export async function resumeVoice({ log = console } = {}) {
  try {
    await prepareVoice();
  } catch (err) {
    log.error(`[voice-player] voice playback is unavailable: ${err.message}`);
    return;
  }
  for (const guildId of listGuildsWithQueue()) getSession(guildId).warmUp();
  for (const { guildId, voiceChannelId } of listGuildsInCall()) {
    try {
      await getSession(guildId).join(voiceChannelId);
      log.log(`[voice-player] rejoined the call in ${guildId}`);
    } catch (err) {
      log.error(`[voice-player] couldn't rejoin the call in ${guildId}: ${err.message}`);
      savePresence(guildId, { voiceChannelId: null });
    }
  }
}

// For the bot's voiceStateUpdate event: re-check whether the bot is alone.
export function onVoiceActivity(guildId) {
  sessions.get(guildId)?.session.evaluateCompany();
}
