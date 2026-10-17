// The music API of Alani on the web (alani.alatomy.com). The web service calls it on the bridge server
// (common/bridgeServer.js) with its own secret (ALANI_WEB_API_SECRET) after checking who is logged in, and
// passes who that is: `discordUserId` (their linked Discord, for a server's player) and `accountId` (their
// Alatomy account, for their personal queue). Nothing here trusts a browser directly.
//
//   GET  /web/music/library                     every playable file, with play counts
//   GET  /web/music/servers?discordUserId=       servers where that person can use the player
//   GET  /web/music/server/:guild?discordUserId= the player of one server
//   POST /web/music/server/:guild/action {discordUserId, action, ...}
//   GET  /web/music/personal/:account[?after=V]  a person's own queue (plays in their browsers, in step);
//                                                with ?after, the answer waits until it is newer than version V
//   POST /web/music/personal/:account/action {action, actionId?, ...}   queue changes, and play / pause /
//                                                seek / started / ended / replace
// Every answer has a Server-Timing header (how long the bot took), to see where time goes.
//   GET  /web/music/stream/:fileId              the audio (Ogg Opus) of one file, for playing in a browser
//
// A server's player follows the same rules as `.avc` (rules.js): anyone in the server may look, changes
// need you in the bot's voice call (or, to add and join, in any voice channel when the bot is free),
// SongMaster for clearing the queue, bot owners for persistent.

import { EventEmitter } from "node:events";
import fs from "node:fs";
import { isOwner } from "../../common/auth.js";
import { hasTag, TAGS } from "../tags/store.js";
import { advance, clearQueue, currentEntry, enqueue, insertNext, jumpTo, moveEntry, nextIndex, previousIndex, removeAt, resolveIndex, setLoop, setShuffle, setSkip, withUpNext } from "./queue.js";
import { ensureInCallerChannel, entryFor, mustBeInBotsCall, mustBeSongMaster } from "./rules.js";
import * as playbackApi from "./personalPlayback.js";

const MAX_ADD = 500; // a whole playlist at once
const WAIT_MS = 25_000; // how long a "tell me when it changes" request waits before answering "no change"
const RECENT_ACTIONS = 50; // per personal queue: action ids already applied (a resent action is not applied twice)
const RECENT_GUILD_DAYS = 90;
const MEMBER_CACHE_MS = 5 * 60 * 1000;
const SNOWFLAKE = /^\d{15,20}$/;
const ACCOUNT_ID = /^[0-9a-f]{32}$/;
const WAIT_FOR_CONVERSION_MS = 20_000;

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, body, headers = {}) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": data.length, "Cache-Control": "no-store", ...headers });
  res.end(data);
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new ApiError(413, "That request is too large.");
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (body && typeof body === "object" && !Array.isArray(body)) return body;
  } catch {
    // falls through
  }
  throw new ApiError(400, "That request body is not valid JSON.");
}

/**
 * deps: { discord: () => Client, getSession(guildId), prepareVoice(), audioCache(), listPlayableFiles(), clock?, random?, waitMs?,
 *         store: { loadState, saveState, loadPlayback, savePlayback, guildsUsedBy, noteGuildUser, playHistory, recordPlay, personalQueueId } }
 */
export function createWebMusicApi(deps) {
  const { store, clock = Date.now, random = Math.random, waitMs = WAIT_MS } = deps;
  const memberCache = new Map(); // "guild|user" -> { until, member }

  // ---------------------------------------------------------------- Discord
  async function isMember(guild, userId) {
    const key = `${guild.id}|${userId}`;
    const hit = memberCache.get(key);
    if (hit && hit.until > Date.now()) return hit.member;
    const member = await guild.members.fetch(userId).then(() => true, () => false);
    memberCache.set(key, { until: Date.now() + MEMBER_CACHE_MS, member });
    return member;
  }

  async function guildFor(guildId, userId) {
    if (!SNOWFLAKE.test(String(userId ?? ""))) throw new ApiError(403, "Link your Discord to your Alatomy account to use a server's player.");
    const guild = SNOWFLAKE.test(String(guildId)) ? deps.discord().guilds.cache.get(guildId) : null;
    if (!guild || !(await isMember(guild, userId))) throw new ApiError(404, "That server isn't available to you.");
    return guild;
  }

  const userVoiceChannel = (guild, userId) => guild.voiceStates.cache.get(userId)?.channelId ?? null;
  const channelName = (guild, id) => (id ? guild.channels.cache.get(id)?.name ?? null : null);
  // messages from rules.js mention channels Discord-style; the web shows their names
  const readable = (guild, text) => text.replace(/<#(\d+)>/g, (_, id) => `#${channelName(guild, id) ?? "voice"}`).replace(/`\.avc join`/g, "Join");

  // ---------------------------------------------------------------- views
  function durationOf(entry) {
    try {
      return deps.audioCache()?.durationOf(entry) ?? null;
    } catch {
      return null;
    }
  }
  const queueView = (state) => state.queue.map((entry, index) => ({ index, name: entry.name, fileId: entry.fileId, skip: Boolean(entry.skip), durationMs: durationOf(entry) }));

  function serverView(guild, userId) {
    const session = deps.getSession(guild.id);
    const state = session.state();
    const connected = session.isConnected();
    const userChannelId = userVoiceChannel(guild, userId);
    const inCall = connected && userChannelId === session.channelId();
    return {
      kind: "server",
      server: { id: guild.id, name: guild.name, iconUrl: guild.iconURL?.({ size: 64 }) ?? null },
      connected,
      channel: connected ? { id: session.channelId(), name: channelName(guild, session.channelId()) } : null,
      you: { inVoiceChannel: Boolean(userChannelId), voiceChannelName: channelName(guild, userChannelId), inCall },
      can: {
        control: inCall,
        join: Boolean(userChannelId) && (!connected || (session.channelId() !== userChannelId && session.humanCount() === 0)),
        songMaster: hasTag(userId, TAGS.SongMaster),
        owner: isOwner(userId),
      },
      playing: session.isPlaying(),
      paused: session.isPaused(),
      positionMs: session.positionMs(),
      cursor: currentEntry(state) ? state.cursor : null,
      queue: queueView(state),
      loop: state.loop,
      shuffle: state.shuffle,
      playCall: state.playCall,
      persistent: state.persistent,
    };
  }

  function personalView(accountId) {
    const id = store.personalQueueId(accountId);
    const state = store.loadState(id);
    return {
      kind: "personal",
      version: versionOf(id),
      cursor: currentEntry(state) ? state.cursor : null,
      nextIndex: nextIndex(state), // what plays next (drawn ahead with shuffle), so devices can load it early
      queue: queueView(state),
      loop: state.loop,
      shuffle: state.shuffle,
      playback: playbackApi.playbackView(store.loadPlayback(id), clock()),
    };
  }

  // ---------------------------------------------------------------- personal queues: waiting for a change
  // Instead of asking every couple of seconds, a device asks "anything newer than version V?" and the
  // answer waits until a change happens (every change wakes the waiting requests at once) or waitMs
  // passes. Versions count changes since this process started; the start time in them makes every
  // version from before a restart look old, so devices simply catch up.
  const boot = Date.now().toString(36);
  const versions = new Map(); // queue id -> changes so far
  const changes = new EventEmitter().setMaxListeners(0);
  const versionOf = (id) => `${boot}.${versions.get(id) ?? 0}`;
  function changed(id) {
    versions.set(id, (versions.get(id) ?? 0) + 1);
    changes.emit(id);
  }
  function waitForChange(id, after, res) {
    if (versionOf(id) !== after) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => (clearTimeout(timer), changes.off(id, done), res.off("close", done), resolve());
      const timer = setTimeout(done, waitMs);
      changes.on(id, done);
      res.on("close", done); // the device went away
    });
  }

  // Devices resend an action they got no answer for; one already applied is not applied again.
  const recentActions = new Map(); // queue id -> Map(action id -> its problem or null)
  function alreadyDone(id, actionId) {
    return typeof actionId === "string" && recentActions.get(id)?.has(actionId);
  }
  function remember(id, actionId, problem) {
    if (typeof actionId !== "string" || actionId.length > 64) return;
    const done = recentActions.get(id) ?? new Map();
    done.set(actionId, problem);
    if (done.size > RECENT_ACTIONS) done.delete(done.keys().next().value);
    recentActions.set(id, done);
  }

  // ---------------------------------------------------------------- the library
  async function filesById(ids) {
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_ADD) throw new ApiError(400, `Choose 1 to ${MAX_ADD} songs.`);
    const files = new Map((await deps.listPlayableFiles()).map((file) => [file.id, file]));
    const found = ids.map((id) => files.get(String(id))).filter(Boolean);
    if (found.length === 0) throw new ApiError(404, "None of those songs exist any more.");
    return found;
  }

  async function library() {
    const history = store.playHistory();
    const files = await deps.listPlayableFiles();
    // every file is in the shared pool for now; uploads ("added by me") come later
    return files.map((file) => ({ id: file.id, name: file.name, size: Number(file.size) || null, addedAt: file.modifiedTime ?? null, type: "public", plays: history.get(file.id)?.plays ?? 0, lastPlayedAt: history.get(file.id)?.lastPlayedAt ?? null }));
  }

  async function servers(userId) {
    if (!SNOWFLAKE.test(String(userId ?? ""))) return [];
    const used = store.guildsUsedBy(userId);
    const cutoff = new Date(Date.now() - RECENT_GUILD_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const out = [];
    for (const guild of deps.discord().guilds.cache.values()) {
      const session = deps.getSession(guild.id);
      const lastUsedAt = used.get(guild.id) ?? null;
      if (!(session.isConnected() || (lastUsedAt && lastUsedAt >= cutoff))) continue;
      if (!(await isMember(guild, userId))) continue;
      out.push({
        id: guild.id,
        name: guild.name,
        iconUrl: guild.iconURL?.({ size: 64 }) ?? null,
        lastUsedAt,
        botInCall: session.isConnected(),
        channelName: channelName(guild, session.channelId()),
        playing: session.isPlaying(),
      });
    }
    return out.sort((a, b) => Number(b.botInCall) - Number(a.botInCall) || String(b.lastUsedAt).localeCompare(String(a.lastUsedAt)));
  }

  // ---------------------------------------------------------------- a server's player
  async function serverAction(guild, userId, body) {
    const session = deps.getSession(guild.id);
    const ctx = { userId, voiceChannelId: userVoiceChannel(guild, userId) };
    const inCall = () => mustBeInBotsCall(ctx, session);
    const on = body.on === true;
    store.noteGuildUser(guild.id, userId);

    switch (body.action) {
      case "join":
        return ensureInCallerChannel(ctx, session);
      case "leave":
        return inCall() ?? void (await session.leave());
      case "pause":
        return inCall() ?? (session.togglePause() ? null : "Nothing is playing.");
      case "next":
        return inCall() ?? (session.skip() ? null : "Nothing to skip.");
      case "previous":
        return inCall() ?? (session.previous() ? null : "Nothing is playing.");
      case "restart":
        return inCall() ?? (session.restart() ? null : "Nothing is playing.");
      case "jump": {
        const index = resolveIndex(session.state(), body.index, body.fileId);
        return index === null ? "No such track." : inCall() ?? void session.skipTo(index + 1);
      }
      case "remove": {
        const index = resolveIndex(session.state(), body.index, body.fileId);
        return index === null ? "No such track." : inCall() ?? void session.remove(index);
      }
      case "move": {
        const from = resolveIndex(session.state(), body.from, body.fileId);
        return inCall() ?? (from !== null && session.move(from, body.to) ? null : "No such track.");
      }
      case "markSkip": {
        const index = resolveIndex(session.state(), body.index, body.fileId);
        return inCall() ?? (index !== null && session.markSkip(index, on) ? null : "No such track.");
      }
      case "loop":
        return inCall() ?? void session.setLoop(on);
      case "shuffle":
        return inCall() ?? void session.setShuffle(on);
      case "playCall":
        return inCall() ?? void session.setPlayCall(on);
      case "persistent":
        return !isOwner(userId) ? "Only a bot owner can change Persistent." : inCall() ?? void session.setPersistent(on);
      case "removeAll":
        return mustBeSongMaster(ctx, "Removing every track") ?? void session.removeAll();
      case "add":
      case "replace": {
        const files = await filesById(body.fileIds);
        if (body.action === "replace") {
          const notAllowed = mustBeSongMaster(ctx, "Replacing the queue");
          if (notAllowed) return notAllowed;
        }
        await deps.prepareVoice();
        const problem = await ensureInCallerChannel(ctx, session);
        if (problem) return problem;
        if (body.action === "replace") session.removeAll();
        session.addMany(files.map((file) => entryFor(file, userId)), body.where === "next" ? "next" : "end");
        return null;
      }
      default:
        throw new ApiError(400, "Unknown action.");
    }
  }

  // ---------------------------------------------------------------- a personal queue
  // Like a server's queue (session.js), its songs are kept converted and converted ahead of time — the
  // current one first, then the rest in the order they will play — so a new song is ready to stream
  // the moment it starts instead of being converted then.
  function convertAhead(id, state) {
    try {
      const cache = deps.audioCache();
      if (!cache) return;
      cache.setPinned(state.queue.map((entry) => entry.key), id); // keep its converted tracks
      const upNext = state.queue[nextIndex(state)];
      const upcoming = [...state.queue.slice(state.cursor), ...state.queue.slice(0, state.cursor)].filter((entry) => !entry.skip && entry !== upNext);
      if (upNext) upcoming.splice(1, 0, upNext); // right after the current one (shuffle's draw included)
      upcoming.forEach((entry, i) => cache.ensure(entry, { urgent: i === 0 }));
    } catch {
      // no audio cache on this host: streaming will say so
    }
  }

  // The queue and where it is in the current song (personalPlayback.js) are shared by all the person's
  // devices. Anything that changes the current song starts it from the beginning, waiting there until the
  // first device actually plays it ("started"); "ended" carries the revision the device saw, so when two
  // devices both finish the song it moves on only once.
  async function personalAction(accountId, body) {
    const id = store.personalQueueId(accountId);
    if (alreadyDone(id, body.actionId)) return recentActions.get(id).get(body.actionId);
    const problem = await applyPersonal(id, accountId, body);
    remember(id, body.actionId, problem);
    return problem;
  }

  async function applyPersonal(id, accountId, body) {
    const state = store.loadState(id);
    const now = clock();
    let pb = store.loadPlayback(id);
    const on = body.on === true;
    const before = currentEntry(state);
    const meant = (index) => resolveIndex(state, index, body.fileId); // the song the device meant, if the queue moved
    let next = state;
    let restart = false; // the same song starts again (looping one song, or jumping to the one playing)

    switch (body.action) {
      case "add":
      case "replace": {
        const entries = (await filesById(body.fileIds)).map((file) => entryFor(file, accountId));
        if (body.action === "replace") next = clearQueue(next);
        if (body.where === "next") for (const entry of [...entries].reverse()) next = insertNext(next, entry);
        else for (const entry of entries) next = enqueue(next, entry);
        if (!before || body.action === "replace") pb = playbackApi.play(pb, now, 0); // start playing what was added
        restart = body.action === "replace";
        break;
      }
      case "next":
      case "ended":
        if (body.action === "ended" && body.rev !== pb.rev) return null; // another device already moved on
        next = advance(state, random);
        restart = true;
        break;
      case "previous": {
        const index = previousIndex(state);
        if (index !== null) next = { ...state, cursor: index };
        restart = true;
        break;
      }
      case "jump": {
        const index = meant(body.index);
        if (index === null) return "No such track.";
        next = jumpTo(state, index);
        pb = playbackApi.play(pb, now, 0);
        restart = true;
        break;
      }
      case "remove": {
        const index = meant(body.index);
        if (index === null) return "No such track.";
        next = removeAt(state, index);
        break;
      }
      case "move": {
        const from = meant(body.from);
        if (from === null) return "No such track.";
        next = moveEntry(state, from, body.to);
        break;
      }
      case "markSkip": {
        const index = meant(body.index);
        if (index === null) return "No such track.";
        next = setSkip(state, index, on);
        if (on && index === state.cursor) (next = advance(next, random)), (restart = true); // skipping the one playing
        break;
      }
      case "loop":
        next = setLoop(state, on);
        break;
      case "shuffle":
        next = setShuffle(state, on);
        break;
      case "removeAll":
        next = clearQueue(state);
        break;
      case "play":
        if (!before) return null;
        if (playbackApi.positionAt(pb, now) < 1000) store.recordPlay(before.fileId, before.name); // a start, not a resume
        pb = playbackApi.play(pb, now, body.positionMs);
        break;
      case "pause":
        pb = playbackApi.pause(pb, now, body.positionMs);
        break;
      case "seek":
        pb = playbackApi.seek(pb, now, body.positionMs);
        break;
      case "started": // a device began playing the song that was waiting: its clock runs from now
        pb = playbackApi.started(pb, now, body.rev, body.positionMs);
        if (!pb) return null; // already started (by another device), or the song changed meanwhile
        break;
      default:
        throw new ApiError(400, "Unknown action.");
    }

    next = withUpNext(next, random); // shuffle's next song, drawn ahead
    const after = currentEntry(next);
    if (!after) pb = pb.playing || pb.positionMs ? playbackApi.stop(pb, now) : pb;
    else if (restart || after.key !== before?.key) {
      pb = playbackApi.restartTrack(pb, now);
      if (pb.playing) store.recordPlay(after.fileId, after.name);
    }
    store.saveState(id, next);
    store.savePlayback(id, pb);
    convertAhead(id, next);
    changed(id);
    return null;
  }

  // ---------------------------------------------------------------- streaming
  async function stream(req, res, fileId) {
    const [file] = await filesById([fileId]);
    await deps.prepareVoice();
    const cache = deps.audioCache();
    const entry = entryFor(file, null);
    const job = cache.ensure(entry, { urgent: true });
    // short tracks are usually ready in a few seconds; a long one starts streaming while it converts
    const giveUpAt = Date.now() + WAIT_FOR_CONVERSION_MS;
    while ((job.status === "pending" || job.status === "running") && Date.now() < giveUpAt) {
      await Promise.race([job.waitForChange(), new Promise((resolve) => setTimeout(resolve, giveUpAt - Date.now()))]);
    }
    if (job.status === "failed") throw new ApiError(502, `Couldn't prepare that song: ${job.error?.message ?? "conversion failed"}`);

    const finished = cache.finishedFile(entry);
    const headers = { "Content-Type": "audio/ogg", "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff" };
    if (!finished) {
      res.writeHead(200, headers); // still converting: no length, no seeking yet
      cache.open(entry).stream.pipe(res);
      return;
    }
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
    if (range) {
      const start = range[1] === "" ? Math.max(0, finished.bytes - Number(range[2])) : Number(range[1]);
      const end = range[1] !== "" && range[2] !== "" ? Math.min(Number(range[2]), finished.bytes - 1) : finished.bytes - 1;
      if (start > end || start >= finished.bytes) {
        res.writeHead(416, { "Content-Range": `bytes */${finished.bytes}` });
        return void res.end();
      }
      res.writeHead(206, { ...headers, "Accept-Ranges": "bytes", "Content-Range": `bytes ${start}-${end}/${finished.bytes}`, "Content-Length": end - start + 1 });
      return void fs.createReadStream(finished.path, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, "Accept-Ranges": "bytes", "Content-Length": finished.bytes });
    fs.createReadStream(finished.path).pipe(res);
  }

  // ---------------------------------------------------------------- routing
  return async function handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    const started = performance.now();
    const send = (status, body) => sendJson(res, status, body, { "Server-Timing": `bot;desc="Alani bot";dur=${(performance.now() - started).toFixed(1)}` });
    const parts = url.pathname.replace(/^\/web\/music\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
    try {
      const body = req.method === "POST" ? await readBody(req) : {};
      const userId = req.method === "GET" ? url.searchParams.get("discordUserId") : body.discordUserId;
      const [what, id, sub] = parts;

      if (req.method === "GET" && what === "library" && !id) return send(200, { files: await library() });
      if (req.method === "GET" && what === "servers" && !id) return send(200, { servers: await servers(userId) });
      if (req.method === "GET" && what === "stream" && id && !sub) return await stream(req, res, id);

      if (what === "server" && id) {
        const guild = await guildFor(id, userId);
        if (req.method === "GET" && !sub) return send(200, serverView(guild, userId));
        if (req.method === "POST" && sub === "action") {
          const problem = await serverAction(guild, userId, body);
          return send(problem ? 409 : 200, { ...(problem ? { error: readable(guild, problem) } : {}), player: serverView(guild, userId) });
        }
      }
      if (what === "personal" && ACCOUNT_ID.test(String(id ?? ""))) {
        if (req.method === "GET" && !sub) {
          const after = url.searchParams.get("after");
          if (after) await waitForChange(store.personalQueueId(id), after, res);
          if (res.destroyed) return;
          return send(200, personalView(id));
        }
        if (req.method === "POST" && sub === "action") {
          const problem = await personalAction(id, body);
          return send(problem ? 409 : 200, { ...(problem ? { error: problem } : {}), player: personalView(id) });
        }
      }
      throw new ApiError(404, "No such route.");
    } catch (error) {
      if (error instanceof ApiError) return send(error.status, { error: error.message });
      console.error(`[voice-player] web API error on ${req.method} ${url.pathname}:`, error);
      if (!res.headersSent) sendJson(res, 500, { error: "The music player had a problem." });
    }
  };
}

