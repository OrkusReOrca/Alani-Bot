// Who may do what with a server's voice player, shared by the `.avc` command and the web app's music API
// (webApi.js). Each check returns an error message, or null when it is fine. `ctx` is the caller:
// { userId, voiceChannelId } (the voice channel they are in, if any).

import { hasTag, TAGS } from "../tags/store.js";
import { cacheKeyFor } from "./audioCache.js";

export const channelMention = (id) => `<#${id}>`;

export function entryFor(file, userId) {
  return { fileId: file.id, name: file.name, mimeType: file.mimeType, version: file.modifiedTime, key: cacheKeyFor(file), addedBy: userId };
}

// ---------- shared checks (each returns an error message, or null if fine) ----------

export function mustBeInCall(ctx) {
  return ctx.voiceChannelId ? null : "Join a voice channel first.";
}

// Controlling playback needs the bot to be in a call AND the caller to be in it.
export function mustBeInBotsCall(ctx, session) {
  if (!session.isConnected()) return "I'm not in a voice call — use `.avc join` first.";
  if (ctx.voiceChannelId !== session.channelId()) return `You need to be in my voice channel (${channelMention(session.channelId())}) to do that.`;
  return null;
}

export function mustBeSongMaster(ctx, what) {
  return hasTag(ctx.userId, TAGS.SongMaster) ? null : `${what} needs the SongMaster tag — a bot owner can grant it with \`.a tag add SongMaster <user>\`.`;
}

// Gets the bot into the caller's channel for play/force play. Returns an error message or null.
export async function ensureInCallerChannel(ctx, session) {
  const notInCall = mustBeInCall(ctx);
  if (notInCall) return notInCall;

  if (session.isConnected() && session.channelId() !== ctx.voiceChannelId) {
    if (session.humanCount() > 0) return `I'm already playing in ${channelMention(session.channelId())} — join that channel to add tracks.`;
  }
  if (!session.isConnected() || session.channelId() !== ctx.voiceChannelId) {
    try {
      await session.join(ctx.voiceChannelId);
    } catch (err) {
      return `Couldn't join your voice channel: ${err.message}`;
    }
  }
  return null;
}
