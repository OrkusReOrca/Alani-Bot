// Radio stations: "On account" music in the web app. A station is a queue with a clock that the BOT runs,
// like a radio: songs follow each other on the bot's own clock, devices tune in and play along loosely
// (they line up closely after a control; otherwise a device that is behind finishes its song at its own
// pace), and a control from any device changes the station for everyone. With several devices listening,
// only the bot decides when a song ends, so devices can't race each other.
//
// One device listening alone leads: the station waits for it. Its song end ("ended") moves the station on,
// and the clock gives it LEAD_GRACE_MS past the song's end before moving on by itself (a device that went
// quiet). So a lone device is never cut off or left behind by the bot's clock.
//
// Stations are not tied to accounts: each has an owner and members (stateStore: radio_stations,
// radio_members). For now every account has one station of its own, created on first use; its id is
// "account:<account id>" (where the account's queue already lived). Listening together (friends joining a
// station by a code) can be added on top of the members table.
//
// The rules kept here:
//   * catching up: whenever anything asks, the station first moves past every song that ended since, on
//     its own clock (so it is right even if nobody asked for a while), and a timer wakes it when the
//     current song ends, so waiting devices hear about the next song at once;
//   * a song that isn't converted yet: the clock waits at its start until it is (or until it starts
//     streaming while it converts);
//   * nobody listening (no device tuned in for ABSENT_MS): it pauses where it was then;
//   * one device listening (by its id, seen within PRESENT_MS): it leads (above);
//   * devices ask "anything newer than version V?" and the answer waits until a change (or waitMs);
//   * a control sent again (no answer reached the device) is applied once (actionId), and index controls
//     name their song (fileId) so a queue that moved meanwhile is no problem.

import { EventEmitter } from "node:events";
import { advance, clearQueue, currentEntry, enqueue, insertNext, jumpTo, moveEntry, nextIndex, previousIndex, removeAt, resolveIndex, setLoop, setShuffle, setSkip, withUpNext } from "./queue.js";
import * as clockApi from "./stationClock.js";

export const ABSENT_MS = 40_000; // no device tuned in for this long: the station pauses
export const LEAD_GRACE_MS = 30_000; // a lone device's song end may come this late before the clock moves on
const PRESENT_MS = 5_000; // a listening device counts as there this long after its last request
const DEVICE = /^[A-Za-z0-9_-]{8,64}$/;
const UNNAMED = ""; // a listening device that didn't say which it is (it never leads)
const RECENT_ACTIONS = 50; // per station: action ids already applied
const MAX_CATCH_UP = 500; // songs moved past in one catch-up (a safety limit)
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Moves a station past every song that ended by `until` (each next song starts the moment the one before
 * ended). Pure. Returns { state, pb, started: [entries that started], changed }.
 */
export function catchUp(state, pb, { until, durationOf, isReady, random = Math.random }) {
  const started = [];
  let changed = false;
  for (let i = 0; i < MAX_CATCH_UP && pb.playing && !pb.waiting; i++) {
    const entry = currentEntry(state);
    const length = entry ? durationOf(entry) : null;
    if (!length) break; // not known (not converted): it can't end on the clock
    const endsAt = Math.max(pb.updatedAt, pb.updatedAt + length - pb.positionMs);
    if (endsAt > until) break;
    state = withUpNext(advance(state, random), random);
    const next = currentEntry(state);
    pb = next ? clockApi.restartTrack(pb, endsAt, { ready: isReady(next) }) : clockApi.stop(pb, endsAt);
    if (next) started.push(next);
    changed = true;
  }
  return { state, pb, started, changed };
}

/**
 * deps: { store: { loadState, saveState, loadPlayback, savePlayback, recordPlay, stationOf(accountId),
 *                  isStationMember(stationId, accountId) },
 *         audioCache(), filesById(ids), entryFor(file, ownerId), clock, random, waitMs, ApiError }
 */
export function createStations(deps) {
  const { store, clock, random, waitMs, ApiError } = deps;
  const bootAt = clock();

  const cache = () => {
    try {
      return deps.audioCache() ?? null;
    } catch {
      return null; // no audio cache on this host: streaming will say so
    }
  };
  const durationOf = (entry) => cache()?.durationOf(entry) ?? null;
  const isReady = (entry) => {
    const c = cache();
    return !c || Boolean(c.finishedFile(entry)) || streamingEarly.has(entry.key);
  };

  // ---------------------------------------------------------------- changes, and waiting for them
  const boot = bootAt.toString(36);
  const versions = new Map(); // station id -> changes so far
  const changes = new EventEmitter().setMaxListeners(0);
  const versionOf = (id) => `${boot}.${versions.get(id) ?? 0}`;
  function changed(id) {
    versions.set(id, (versions.get(id) ?? 0) + 1);
    changes.emit(id);
  }

  // ---------------------------------------------------------------- who is listening
  // station id -> { open: waiting requests of listening devices, lastSeen, devices: device -> { open, lastSeen } }
  const presence = new Map();
  function seen(id, device) {
    const p = presence.get(id) ?? { open: 0, lastSeen: 0, devices: new Map() };
    const d = p.devices.get(device) ?? { open: 0, lastSeen: 0 };
    p.lastSeen = d.lastSeen = clock();
    p.devices.set(device, d);
    presence.set(id, p);
    return [p, d];
  }
  /** The device listening alone (it leads), or null (nobody, several, or one without an id). */
  function leaderOf(id, now = clock()) {
    const p = presence.get(id);
    if (!p) return null;
    const here = [];
    for (const [device, d] of p.devices) {
      if (d.open > 0 || now - d.lastSeen < PRESENT_MS) here.push(device);
      else if (now - d.lastSeen > ABSENT_MS) p.devices.delete(device); // long gone
    }
    return here.length === 1 && here[0] !== UNNAMED ? here[0] : null;
  }
  /** null while somebody listens; otherwise when the station became unattended. */
  function unattendedSince(id, now) {
    const p = presence.get(id);
    const last = p ? p.lastSeen : bootAt; // after a restart, devices have ABSENT_MS to come back
    return p?.open > 0 || now - last < ABSENT_MS ? null : last + ABSENT_MS;
  }

  // ---------------------------------------------------------------- keeping the station going
  const timers = new Map(); // station id -> timer for the end of the current song
  const waiting = new Map(); // track key -> station ids whose current song waits for it
  const streamingEarly = new Set(); // track keys streaming while they convert (their clocks may run)

  // Like a server's queue (session.js), a station's songs are kept converted and converted ahead — the
  // current one first, then the one that plays next, then the rest in playing order.
  function convertAhead(id, state) {
    const c = cache();
    if (!c) return;
    c.setPinned(state.queue.map((entry) => entry.key), id);
    const upNext = state.queue[nextIndex(state)];
    const upcoming = [...state.queue.slice(state.cursor), ...state.queue.slice(0, state.cursor)].filter((entry) => !entry.skip && entry !== upNext);
    if (upNext) upcoming.splice(1, 0, upNext);
    upcoming.forEach((entry, i) => c.ensure(entry, { urgent: i === 0 }));
  }

  function save(id, state, pb) {
    store.saveState(id, state);
    store.savePlayback(id, pb);
    convertAhead(id, state);
    changed(id);
  }

  /** Wakes the station when its current song ends, or when the song it waits for is ready. */
  function arm(id, state, pb) {
    clearTimeout(timers.get(id));
    timers.delete(id);
    const entry = currentEntry(state);
    if (!pb.playing || !entry) return;
    if (pb.waiting) return waitFor(id, entry);
    const length = durationOf(entry);
    if (!length) return;
    const grace = leaderOf(id) ? LEAD_GRACE_MS : 0; // a lone device says when the song ended
    const ms = pb.updatedAt + length - pb.positionMs + grace - clock();
    const timer = setTimeout(() => settle(id), Math.min(MAX_TIMER_MS, Math.max(0, ms) + 50));
    timer.unref?.();
    timers.set(id, timer);
  }

  function waitFor(id, entry) {
    const c = cache();
    const job = c?.ensure(entry, { urgent: true });
    if (!job || job.status === "done" || job.status === "failed") return songReady(entry.key, [id]);
    if (!waiting.has(entry.key)) {
      waiting.set(entry.key, new Set());
      whenConverted(job, () => songReady(entry.key));
    }
    waiting.get(entry.key).add(id);
  }

  function whenConverted(job, fn) {
    const onChange = () => (job.status === "done" || job.status === "failed") && (job.off("change", onChange), fn());
    job.on("change", onChange);
  }

  /** The song can play now: the stations waiting for it start their clocks. */
  function songReady(key, ids = waiting.get(key) ?? []) {
    waiting.delete(key);
    for (const id of ids) {
      const state = store.loadState(id);
      const pb = store.loadPlayback(id);
      if (currentEntry(state)?.key !== key || !pb.waiting) continue;
      const next = clockApi.ready(pb, clock());
      store.savePlayback(id, next);
      changed(id);
      arm(id, state, next);
    }
  }

  /** A song started streaming before its conversion finished (a long one): stations may start it. */
  function streamingWhileConverting(key, job) {
    streamingEarly.add(key);
    whenConverted(job, () => streamingEarly.delete(key));
    songReady(key);
  }

  /** Brings a station up to now: songs that ended on its clock; a pause if nobody listened. */
  function settle(id) {
    const now = clock();
    const unattended = unattendedSince(id, now);
    const until = unattended ?? (leaderOf(id, now) ? now - LEAD_GRACE_MS : now);
    let { state, pb, started, changed: moved } = catchUp(store.loadState(id), store.loadPlayback(id), { until, durationOf, isReady, random });
    for (const entry of started) store.recordPlay(entry.fileId, entry.name);
    if (unattended !== null && pb.playing) (pb = clockApi.pause(pb, until)), (moved = true);
    if (moved) save(id, state, pb);
    arm(id, state, pb);
    return { state, pb };
  }

  // ---------------------------------------------------------------- what devices see
  const queueView = (state) => state.queue.map((entry, index) => ({ index, name: entry.name, fileId: entry.fileId, skip: Boolean(entry.skip), durationMs: durationOf(entry) }));

  function view(id) {
    const state = store.loadState(id);
    return {
      kind: "station",
      station: id,
      version: versionOf(id),
      cursor: currentEntry(state) ? state.cursor : null,
      nextIndex: nextIndex(state), // what plays next (drawn ahead with shuffle), so devices can load it early
      queue: queueView(state),
      loop: state.loop,
      shuffle: state.shuffle,
      playback: clockApi.playbackView(store.loadPlayback(id), clock()),
    };
  }

  /** The station this account listens to (its own, or one it is a member of). */
  function stationFor(accountId, wanted) {
    const own = store.stationOf(accountId);
    if (!wanted || wanted === own) return own;
    if (store.isStationMember(wanted, accountId)) return wanted;
    throw new ApiError(404, "That station isn't available to you.");
  }

  /**
   * The station's state; with `after`, waits until it is newer than that version (or waitMs).
   * listening: the asking device plays it (counts as somebody listening); device: which one it is.
   */
  async function look(id, { after, listening, device, res }) {
    const who = DEVICE.test(device ?? "") ? device : UNNAMED;
    if (listening) seen(id, who);
    settle(id);
    if (after && after === versionOf(id)) {
      const [p, d] = listening ? seen(id, who) : [];
      if (p) p.open++, d.open++;
      await new Promise((resolve) => {
        const done = () => (clearTimeout(timer), changes.off(id, done), res.off("close", done), resolve());
        const timer = setTimeout(done, waitMs);
        changes.on(id, done);
        res.on("close", done); // the device went away
      });
      if (p) (p.open--, d.open--, seen(id, who));
    }
    return view(id);
  }

  // ---------------------------------------------------------------- controls
  const recentActions = new Map(); // station id -> Map(action id -> its problem or null)

  async function act(id, ownerId, body) {
    const done = recentActions.get(id);
    if (typeof body.actionId === "string" && done?.has(body.actionId)) return done.get(body.actionId);
    const problem = await apply(id, ownerId, body);
    if (typeof body.actionId === "string" && body.actionId.length <= 64) {
      const map = done ?? new Map();
      map.set(body.actionId, problem);
      if (map.size > RECENT_ACTIONS) map.delete(map.keys().next().value);
      recentActions.set(id, map);
    }
    return problem;
  }

  async function apply(id, ownerId, body) {
    if (body.action === "ended") return ended(id, body);
    const { state, pb: settled } = settle(id);
    const now = clock();
    let pb = settled;
    const on = body.on === true;
    const before = currentEntry(state);
    const meant = (index) => resolveIndex(state, index, body.fileId); // the song the device meant, if the queue moved
    let next = state;
    let restart = false; // the same song starts again (jumping to the one playing, replacing the queue)

    switch (body.action) {
      case "add":
      case "replace": {
        const entries = (await deps.filesById(body.fileIds)).map((file) => deps.entryFor(file, ownerId));
        if (body.action === "replace") next = clearQueue(next);
        if (body.where === "next") for (const entry of [...entries].reverse()) next = insertNext(next, entry);
        else for (const entry of entries) next = enqueue(next, entry);
        if (!before || body.action === "replace") pb = clockApi.play(pb, now, 0); // start playing what was added
        restart = body.action === "replace";
        break;
      }
      case "next":
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
        pb = clockApi.play(pb, now, 0);
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
        if (clockApi.positionAt(pb, now) < 1000) store.recordPlay(before.fileId, before.name); // a start, not a resume
        pb = clockApi.play(pb, now, body.positionMs);
        break;
      case "pause":
        pb = clockApi.pause(pb, now, body.positionMs);
        break;
      case "seek":
        pb = clockApi.seek(pb, now, body.positionMs);
        break;
      default:
        throw new ApiError(400, "Unknown action.");
    }

    next = withUpNext(next, random); // shuffle's next song, drawn ahead
    const after = currentEntry(next);
    if (!after) pb = pb.playing || pb.positionMs ? clockApi.stop(pb, now) : pb;
    else if (restart || after.key !== before?.key) {
      pb = clockApi.restartTrack(pb, now, { ready: isReady(after) });
      if (pb.playing) store.recordPlay(after.fileId, after.name);
    }
    if (pb.rev !== settled.rev) pb = clockApi.byAction(pb); // devices line up with it closely
    save(id, next, pb);
    arm(id, next, pb);
    return null;
  }

  /**
   * A device finished song number `playId`. Only the lead device's (listening alone) counts: the station
   * moves on now, as its clock would have. Anything else is ignored (the clock decides).
   */
  function ended(id, body) {
    const { state, pb } = settle(id);
    const now = clock();
    if (leaderOf(id, now) !== body.device || body.playId !== pb.playId || !pb.playing || pb.waiting) return null;
    const next = withUpNext(advance(state, random), random);
    const entry = currentEntry(next);
    const after = entry ? clockApi.restartTrack(pb, now, { ready: isReady(entry) }) : clockApi.stop(pb, now);
    if (entry) store.recordPlay(entry.fileId, entry.name);
    save(id, next, after);
    arm(id, next, after);
    return null;
  }

  return { stationFor, look, act, view, streamingWhileConverting };
}
