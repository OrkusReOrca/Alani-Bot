// ".avc <subcommand> ..." — the voice player.
//
//   .avc join                          join your voice channel (resumes the queue)
//   .avc play FILE NAME                add a file from the Drive folder to the end of the queue
//   .avc force play FILE NAME          SongMaster: play it next and cut the current track short
//   .avc pause                         pause / resume
//   .avc skip
//   .avc queue                         list the queue with lengths
//   .avc queue loop on|off
//   .avc queue shuffle on|off          (shuffle on also means looping)
//   .avc queue playcall on|off         "Now playing" messages on/off (per server)
//   .avc remove FILE NAME              take a track out of the queue
//   .avc removeall                     SongMaster: clear the queue
//   .avc list [a|d]                    every playable file, in pages (a = A-Z, d = newest first)
//   .avc status
//   .avc leave                         leave the call (the queue is kept)
//
// Who may do what: viewing (queue, status) is open to anyone in the server.
// Everything else needs you to be in the voice channel the bot is in (play and
// join also work when the bot isn't in a call yet — it joins yours). force play
// and removeall need the SongMaster tag (bot owners always have it).

import { hasTag, TAGS } from "../tags/store.js";
import { describeQueue, describeSettings } from "./format.js";
import { findPlayableFile, listPlayableFiles } from "./library.js";
import { buildListPages, SORTS } from "./listPages.js";
import { pagesAsText } from "../../common/pagination.js";
import { cacheKeyFor } from "./audioCache.js";
import { matchByName, cleanQuery } from "./match.js";
import { getSession, setTextChannel, prepareVoice } from "./manager.js";

export const data = {
  name: "avc",
};

export const aiGuide = `
.avc is the voice-call music player. It plays audio files from a Google Drive folder in the voice channel the user is in.
.avc join                        — join the caller's voice channel (resumes the saved queue)
.avc play <file name>            — add a file to the END of the queue (joins the caller's call if the bot isn't in one). Name matching ignores case and extension; a unique partial name works.
.avc force play <file name>      — play it NEXT and skip the current track (SongMaster tag only)
.avc pause                       — pause; run again to resume
.avc skip                        — skip the current track
.avc queue                       — list the queue with each track's length
.avc queue loop on|off           — loop the queue
.avc queue shuffle on|off        — shuffle (also implies looping)
.avc queue playcall on|off       — whether the bot posts a "Now playing" message when a track starts (per server; errors and leave notices still post)
.avc remove <file name>          — remove a track from the queue
.avc removeall                   — clear the whole queue (SongMaster tag only)
.avc list [a|d]                  — show every playable file in the Drive folder as pages with ⬅️ ➡️ buttons; a = alphabetical (default), d = newest first. Open to anyone; use it to find the exact file name for play.
.avc status                      — whether the bot is in a call, what is playing, loop/shuffle/playcall settings
.avc leave                       — leave the call (the queue is kept)
Everything except queue/status needs the caller to be in the bot's voice channel (see "Caller's voice channel" in the context). Finished tracks are removed unless loop or shuffle is on.`;

// Removing every track is the one thing here that can't be undone.
export const isDestructive = (args) => args[0]?.toLowerCase() === "removeall";

const USAGE = [
  "Usage: `.avc join` · `.avc play <file>` · `.avc force play <file>` · `.avc pause` · `.avc skip`",
  "`.avc list [a|d]` · `.avc queue` · `.avc queue loop on|off` · `.avc queue shuffle on|off` · `.avc queue playcall on|off` · `.avc remove <file>` · `.avc removeall` · `.avc status` · `.avc leave`",
].join("\n");

const ON_OFF = { on: true, off: false };
const channelMention = (id) => `<#${id}>`;

function entryFor(file, userId) {
  return { fileId: file.id, name: file.name, mimeType: file.mimeType, version: file.modifiedTime, key: cacheKeyFor(file), addedBy: userId };
}

// ---------- shared checks (each returns an error message, or null if fine) ----------

function mustBeInCall(ctx) {
  return ctx.voiceChannelId ? null : "Join a voice channel first.";
}

// Controlling playback needs the bot to be in a call AND the caller to be in it.
function mustBeInBotsCall(ctx, session) {
  if (!session.isConnected()) return "I'm not in a voice call — use `.avc join` first.";
  if (ctx.voiceChannelId !== session.channelId()) return `You need to be in my voice channel (${channelMention(session.channelId())}) to do that.`;
  return null;
}

function mustBeSongMaster(ctx, what) {
  return hasTag(ctx.userId, TAGS.SongMaster) ? null : `${what} needs the SongMaster tag — a bot owner can grant it with \`.a tag add SongMaster <user>\`.`;
}

// Gets the bot into the caller's channel for play/force play. Returns an error message or null.
async function ensureInCallerChannel(ctx, session) {
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

// ---------- subcommands ----------

async function handleJoin(ctx, session) {
  const problem = await ensureInCallerChannel(ctx, session);
  if (problem) return problem;
  const queueLength = session.state().queue.length;
  return queueLength > 0 ? `Joined ${channelMention(ctx.voiceChannelId)} and resumed the queue (${queueLength} track${queueLength === 1 ? "" : "s"}).` : `Joined ${channelMention(ctx.voiceChannelId)}.`;
}

async function handlePlay(ctx, session, nameArgs, { force }, { prepareVoice, findPlayableFile }) {
  const query = cleanQuery(nameArgs.join(" "));
  if (!query) return force ? "Usage: `.avc force play <file name>`" : "Usage: `.avc play <file name>`";
  if (force) {
    const denied = mustBeSongMaster(ctx, "`.avc force play`");
    if (denied) return denied;
  }

  let match;
  try {
    await prepareVoice();
    match = await findPlayableFile(query);
  } catch (err) {
    return `Couldn't read the file list: ${err.message}`;
  }
  if (match.status === "none") return `No file matching "${query}" in the Drive folder.`;
  if (match.status === "many") return `"${query}" matches several files — be more specific:\n${match.items.slice(0, 15).map((f) => `• ${f.name}`).join("\n")}`;

  const problem = await ensureInCallerChannel(ctx, session);
  if (problem) return problem;

  const entry = entryFor(match.item, ctx.userId);
  if (force) {
    session.force(entry);
    return `Playing **${entry.name}** next${session.isPlaying() ? " (skipped the current track)" : ""}.`;
  }
  const { position, startsNow } = session.add(entry);
  return startsNow ? `Playing **${entry.name}**.` : `Added **${entry.name}** to the queue (position ${position}).`;
}

// The per-server switches that live next to the queue: how to set each one and
// an optional extra note for the confirmation.
const QUEUE_SWITCHES = {
  loop: {
    label: "Loop",
    apply: (session, on) => session.setLoop(on),
    note: (state, on) => (!on && state.shuffle ? "\nLoop stays active while shuffle is on." : ""),
  },
  shuffle: { label: "Shuffle", apply: (session, on) => session.setShuffle(on) },
  playcall: { label: "PlayCall", apply: (session, on) => session.setPlayCall(on) },
};
const QUEUE_USAGE = "Usage: `.avc queue` · `.avc queue loop on|off` · `.avc queue shuffle on|off` · `.avc queue playcall on|off`";

function handleQueue(ctx, session, rest) {
  if (rest.length === 0) {
    return describeQueue(session.state(), { durationOf: (entry) => session.durationOf(entry), playing: session.isPlaying(), paused: session.isPaused() });
  }

  const [setting, value] = rest.map((word) => word.toLowerCase());
  const switchDef = QUEUE_SWITCHES[setting];
  if (!switchDef || !(value in ON_OFF)) return QUEUE_USAGE;

  const denied = mustBeInBotsCall(ctx, session);
  if (denied) return denied;

  const on = ON_OFF[value];
  const state = switchDef.apply(session, on);
  return `${switchDef.label} is now **${on ? "on" : "off"}**.${switchDef.note?.(state, on) ?? ""}\n${describeSettings(state)}`;
}

function handleRemove(ctx, session, nameArgs) {
  const query = cleanQuery(nameArgs.join(" "));
  if (!query) return "Usage: `.avc remove <file name>`";
  const denied = mustBeInBotsCall(ctx, session);
  if (denied) return denied;

  const { queue } = session.state();
  const match = matchByName(queue, query, (entry) => entry.name);
  if (match.status === "none") return `"${query}" isn't in the queue.`;
  if (match.status === "many") return `"${query}" matches several tracks — be more specific:\n${match.items.map((e) => `• ${e.name}`).join("\n")}`;

  session.remove(queue.indexOf(match.item));
  return `Removed **${match.item.name}** from the queue.`;
}

function describePause(result) {
  if (result === "paused") return "Paused. Run `.avc pause` again to resume.";
  return result === "resumed" ? "Resumed." : "Nothing is playing.";
}

// Shows the Drive folder's files as pages with buttons (or plain text where the
// caller can't show them). Replies itself, so returns nothing.
async function handleList(ctx, sortArg, { listPlayableFiles }) {
  const sort = (sortArg ?? "a").toLowerCase();
  if (!SORTS[sort]) return void (await ctx.reply("Usage: `.avc list` (A–Z) · `.avc list a` (A–Z) · `.avc list d` (newest first)"));

  let files;
  try {
    files = await listPlayableFiles();
  } catch (err) {
    return void (await ctx.reply(`Couldn't read the file list: ${err.message}`));
  }
  const pages = buildListPages(files, sort);
  await (ctx.replyPages ? ctx.replyPages(pages) : ctx.reply(pagesAsText(pages)));
}

function handleStatus(session) {
  const state = session.state();
  const [current] = state.queue;
  return [
    session.isConnected() ? `Voice: connected to ${channelMention(session.channelId())}` : "Voice: not in a call",
    current ? `Now playing: **${current.name}**${session.isPlaying() ? (session.isPaused() ? " (paused)" : "") : " (waiting — not in a call)"}` : "Nothing is queued.",
    `Queue: ${state.queue.length} track${state.queue.length === 1 ? "" : "s"}`,
    describeSettings(state),
  ].join("\n");
}

async function run(ctx, args, deps) {
  if (!ctx.guildId) {
    await ctx.reply("The voice player only works in a server.");
    return;
  }

  const session = deps.getSession(ctx.guildId);
  deps.setTextChannel(ctx.guildId, ctx.channelId);

  const [sub, ...rest] = args;
  const verb = sub?.toLowerCase();
  let reply;

  switch (verb) {
    case "join":
      reply = await handleJoin(ctx, session);
      break;
    case "play":
      reply = await handlePlay(ctx, session, rest, { force: false }, deps);
      break;
    case "force":
      reply = rest[0]?.toLowerCase() === "play" ? await handlePlay(ctx, session, rest.slice(1), { force: true }, deps) : USAGE;
      break;
    case "pause":
      reply = mustBeInBotsCall(ctx, session) ?? describePause(session.togglePause());
      break;
    case "skip": {
      reply = mustBeInBotsCall(ctx, session);
      if (!reply) {
        const skipped = session.skip();
        reply = skipped ? `Skipped **${skipped.name}**.` : "Nothing to skip.";
      }
      break;
    }
    case "queue":
      reply = handleQueue(ctx, session, rest);
      break;
    case "remove":
      reply = handleRemove(ctx, session, rest);
      break;
    case "removeall": {
      reply = mustBeSongMaster(ctx, "`.avc removeall`");
      if (!reply) {
        const count = session.state().queue.length;
        session.removeAll();
        reply = count > 0 ? `Cleared the queue (${count} track${count === 1 ? "" : "s"}).` : "The queue was already empty.";
      }
      break;
    }
    case "list":
      await handleList(ctx, rest[0], deps);
      return;
    case "status":
      reply = handleStatus(session);
      break;
    case "leave": {
      reply = mustBeInBotsCall(ctx, session);
      if (!reply) {
        await session.leave();
        reply = "Left the call. The queue is saved — `.avc join` resumes it.";
      }
      break;
    }
    default:
      reply = USAGE;
  }

  await ctx.reply(reply);
}

// `deps` is what the command needs from the outside world; tests pass fakes.
export function createExecute(deps) {
  return (ctx, args = []) => run(ctx, args, deps);
}

export const execute = createExecute({ getSession, setTextChannel, prepareVoice, findPlayableFile, listPlayableFiles });
