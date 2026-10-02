// The real audio output of a server's voice player: a Discord voice connection
// plus an audio player (@discordjs/voice). The library is imported lazily — it's
// an optional dependency — so a host that can't install it only loses voice
// playback, not the whole bot.
//
// Tracks arrive as Ogg-Opus streams (see audioCache.js), which Discord plays
// without re-encoding.

import { getClient } from "../../common/discordClient.js";
import { limits } from "./config.js";

export function createDiscordOutput({ guildId }) {
  let voice = null;
  let connection = null;
  let player = null;
  let channelId = null;
  let playback = null; // { id, onFinish, onError } for the track now playing
  let nextPlaybackId = 0;
  let closedCallback = () => {};

  async function loadVoice() {
    try {
      voice ??= await import("@discordjs/voice");
    } catch (err) {
      throw new Error(`voice playback isn't available on this host (${err.message.split("\n")[0]})`);
    }
    return voice;
  }

  // Reports the track as finished/failed exactly once, and only if it is still the current one.
  function endPlayback(report) {
    const current = playback;
    playback = null;
    if (current) report(current);
  }

  function wireConnection(conn) {
    conn.on(voice.VoiceConnectionStatus.Disconnected, async () => {
      try {
        // Moved to another channel or reconnecting: give it a moment to recover.
        await Promise.race([
          voice.entersState(conn, voice.VoiceConnectionStatus.Signalling, 5000),
          voice.entersState(conn, voice.VoiceConnectionStatus.Connecting, 5000),
        ]);
      } catch {
        conn.destroy();
      }
    });
    conn.on(voice.VoiceConnectionStatus.Destroyed, () => {
      if (connection === conn) {
        connection = null;
        channelId = null;
        endPlayback(() => {});
        closedCallback();
      }
    });
  }

  function ensurePlayer() {
    if (player) return;
    player = voice.createAudioPlayer();
    player.on("stateChange", (from, to) => {
      if (to.status === voice.AudioPlayerStatus.Idle && from.status !== voice.AudioPlayerStatus.Idle) endPlayback((p) => p.onFinish());
    });
    player.on("error", (err) => endPlayback((p) => p.onError(err)));
  }

  return {
    async join(targetChannelId) {
      await loadVoice();
      const channel = await getClient().channels.fetch(targetChannelId);
      if (!channel?.isVoiceBased()) throw new Error("that isn't a voice channel");

      const isNew = !connection;
      connection = voice.joinVoiceChannel({
        channelId: channel.id,
        guildId,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: true,
      });
      if (isNew) wireConnection(connection);

      try {
        await voice.entersState(connection, voice.VoiceConnectionStatus.Ready, limits.joinTimeoutMs);
      } catch {
        connection.destroy();
        throw new Error("couldn't connect to the voice channel (timed out)");
      }
      ensurePlayer();
      connection.subscribe(player);
      channelId = channel.id;
    },

    leave() {
      playback = null;
      player?.stop(true);
      const closing = connection;
      connection = null;
      channelId = null;
      closing?.destroy();
    },

    play(stream, { onFinish, onError }) {
      const id = ++nextPlaybackId;
      playback = { id, onFinish, onError };
      const resource = voice.createAudioResource(stream, { inputType: voice.StreamType.OggOpus });
      resource.playStream.on("error", (err) => {
        if (playback?.id === id) endPlayback((p) => p.onError(err));
      });
      player.play(resource);
    },

    // Stops the current track WITHOUT reporting it as finished.
    stopPlayback() {
      playback = null;
      player?.stop(true);
    },

    pause: () => player?.pause(true),
    resume: () => player?.unpause(),
    channelId: () => channelId,

    humanCount() {
      const channel = channelId && getClient().channels.cache.get(channelId);
      return channel ? channel.members.filter((member) => !member.user.bot).size : 0;
    },

    onClosed(callback) {
      closedCallback = callback;
    },
  };
}
