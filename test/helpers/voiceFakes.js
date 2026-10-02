// Fakes for the voice player: audio output, cache, store and timers.

import { Readable } from "stream";
import { createGuildSession } from "../../src/features/voice-player/session.js";
import { emptyState } from "../../src/features/voice-player/queue.js";

export function fakeOutput() {
  let channel = null;
  let current = null;
  let humans = 1;
  let closed = () => {};
  const log = [];
  const playbacks = []; // the callbacks of every track ever started, oldest first

  return {
    log,
    playbacks,
    async join(id) {
      if (id === "bad") throw new Error("timed out");
      channel = id;
      log.push(`join ${id}`);
    },
    leave() {
      channel = null;
      current = null;
      log.push("leave");
    },
    play(stream, callbacks) {
      current = callbacks;
      playbacks.push(callbacks);
      log.push("play");
    },
    stopPlayback() {
      current = null;
      log.push("stop");
    },
    pause: () => log.push("pause"),
    resume: () => log.push("resume"),
    humanCount: () => humans,
    channelId: () => channel,
    onClosed: (callback) => (closed = callback),
    // ---- test controls ----
    finishTrack: () => current.onFinish(),
    failTrack: (error) => current.onError(error),
    setHumans: (n) => (humans = n),
    close: () => closed(),
  };
}

export function fakeCache(durations = {}) {
  const opened = [];
  return {
    opened,
    pinned: [],
    open(entry) {
      opened.push(entry.name);
      return { stream: Readable.from([]) };
    },
    ensure() {},
    durationOf: (entry) => durations[entry.name],
    setPinned(keys) {
      this.pinned = keys;
    },
  };
}

export function memoryStore() {
  const states = new Map();
  return {
    loadState: (guildId) => structuredClone(states.get(guildId) ?? emptyState()),
    saveState: (guildId, state) => states.set(guildId, structuredClone(state)),
    has: (guildId) => states.has(guildId),
  };
}

export function fakeTimers() {
  const pending = new Map();
  let nextId = 1;
  return {
    setTimer: (fn, ms) => {
      const id = nextId++;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimer: (id) => pending.delete(id),
    // Fires (and removes) the pending timer with this delay.
    fire(ms) {
      const [id, timer] = [...pending.entries()].find(([, t]) => t.ms === ms) ?? [];
      assert(id, `no pending timer of ${ms} ms`);
      pending.delete(id);
      return timer.fn();
    },
    count: () => pending.size,
    has: (ms) => [...pending.values()].some((t) => t.ms === ms),
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export const TIMING = { idleLeaveMs: 300_000, aloneLeaveMs: 60_000 };

export const track = (name) => ({ fileId: `id-${name}`, name, key: `key-${name}`, mimeType: "audio/mpeg", version: "v1", addedBy: "u1" });

export function makeSession({ store = memoryStore(), output = fakeOutput(), cache = fakeCache(), timers = fakeTimers(), random = () => 0, guildId = "g1" } = {}) {
  const announcements = [];
  const session = createGuildSession({
    guildId,
    store,
    getCache: () => cache,
    output,
    announce: (text) => announcements.push(text),
    timing: TIMING,
    random,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  const names = () => store.loadState(guildId).queue.map((t) => t.name);
  return { session, store, output, cache, timers, announcements, names };
}
