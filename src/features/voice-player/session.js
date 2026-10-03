// One server's voice player: connects/disconnects, plays the current track, moves on when
// a track ends, and applies the queue rules (queue.js). The queue itself lives
// in the database (stateStore.js) and is loaded/saved around every change, never
// held here, so a backup restore can't leave a stale copy in memory.
//
// Everything outside this file is injected, so the whole flow is tested with a
// fake audio output and a fake cache:
//
//   output  { join(channelId), leave(), play(stream, { onFinish, onError }),
//             stopPlayback(), pause(), resume(), humanCount(), channelId(),
//             onClosed(callback) }
//   cache   { open(entry) -> { stream }, ensure(entry), durationOf(entry), setPinned(keys) }
//   store   { loadState(guildId), saveState(guildId, state) }
//   announce(text)   posts a message in the text channel the last command came from

import { advance, jumpTo, currentEntry, enqueue, enqueueFront, insertNext, removeAt, clearQueue, setLoop, setShuffle, setPlayCall, setPersistent } from "./queue.js";

export function createGuildSession({ guildId, store, getCache, output, announce, timing, random = Math.random, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let connected = false;
  let playing = false;
  let paused = false;
  let token = 0; // identifies the current playback; callbacks from older ones are ignored
  let idleTimer = null;
  let aloneTimer = null;

  const load = () => store.loadState(guildId);
  const save = (state) => {
    store.saveState(guildId, state);
    refreshCache(state);
    return state;
  };

  // Pin every queued track (so none is evicted) and convert them in queue order.
  function refreshCache(state) {
    try {
      const cache = getCache();
      cache.setPinned(state.queue.map((entry) => entry.key));
      for (const entry of state.queue) cache.ensure(entry);
    } catch {
      // The cache is unavailable (e.g. no ffmpeg on this host); playing will report it.
    }
  }

  function clearTimers() {
    clearTimer(idleTimer);
    clearTimer(aloneTimer);
    idleTimer = aloneTimer = null;
  }

  async function leaveBecause(reason) {
    await session.leave();
    announce(reason);
  }

  // Persistent servers never auto-leave, so there's nothing to arm.
  function armIdleTimer() {
    clearTimer(idleTimer);
    if (load().persistent) return;
    idleTimer = setTimer(() => leaveBecause(`Left the call — nothing was playing for ${Math.round(timing.idleLeaveMs / 60000)} minutes. The queue is kept.`), timing.idleLeaveMs);
  }

  function stopPlayback() {
    token++;
    playing = false;
    paused = false;
    output.stopPlayback();
  }

  // Starts the current track (or goes idle if the queue has ended).
  function startCurrent() {
    const entry = currentEntry(load());
    clearTimer(idleTimer);
    if (!entry || !connected) {
      if (connected) armIdleTimer();
      return;
    }

    const myToken = ++token;
    try {
      const { stream } = getCache().open(entry);
      output.play(stream, {
        onFinish: () => onTrackEnded(myToken),
        onError: (err) => onTrackFailed(myToken, entry, err),
      });
    } catch (err) {
      onTrackFailed(myToken, entry, err);
      return;
    }
    playing = true;
    paused = false;
    // PlayCall (per server): off silences this message only; failures and leave notices always post.
    if (load().playCall) announce(`Now playing: **${entry.name}**`);
  }

  function onTrackEnded(myToken) {
    if (myToken !== token) return;
    playing = false;
    save(advance(load(), random));
    startCurrent();
  }

  // A track that can't be played is dropped (not looped — it would fail forever).
  function onTrackFailed(myToken, entry, err) {
    if (myToken !== token) return;
    playing = false;
    console.error(`[voice-player] couldn't play "${entry.name}" in ${guildId}:`, err);
    announce(`Couldn't play **${entry.name}**: ${err.message} — skipping it.`);
    const state = load();
    save(currentEntry(state)?.key === entry.key ? removeAt(state, state.cursor) : state);
    startCurrent();
  }

  const session = {
    isConnected: () => connected,
    isPlaying: () => playing,
    isPaused: () => paused,
    channelId: () => output.channelId(),
    humanCount: () => output.humanCount(),
    state: () => load(),

    // Joins (or moves to) a voice channel and resumes the queue at its current
    // track, from the start of that track. Throws if the connection can't be made.
    async join(channelId) {
      await output.join(channelId);
      connected = true;
      clearTimers();
      const resumed = currentEntry(load()) !== null;
      if (resumed) startCurrent();
      else armIdleTimer();
      return { resumed };
    },

    async leave() {
      stopPlayback();
      clearTimers();
      connected = false;
      output.leave();
    },

    // Adds to the end. Returns { position, startsNow }.
    add(entry) {
      const state = save(enqueue(load(), entry));
      if (connected && !playing) startCurrent();
      // It starts now when it became the current track (the queue was empty or had ended).
      return { position: state.queue.length, startsNow: connected && state.cursor === state.queue.length - 1 };
    },

    // Plays this track next and cuts the current one short. When nothing is
    // playing it simply goes to the front.
    force(entry) {
      if (playing) {
        stopPlayback();
        // Retire the current track in queue order (a shuffle must not pick another one here).
        save(advance(insertNext(load(), entry), random, { inOrder: true }));
      } else {
        save(enqueueFront(load(), entry));
      }
      if (connected) startCurrent();
    },

    // Returns the skipped entry, or null if there was nothing to skip.
    skip() {
      const current = currentEntry(load());
      if (!current) return null;
      stopPlayback();
      save(advance(load(), random));
      startCurrent();
      return current;
    },

    // Jumps to the track at `position` (1-based, as numbered in the queue list).
    // Returns { entry, dropped } — dropped is how many tracks were removed
    // because looping is off (they count as played) — or null if there's no such
    // position. Jumping to the current track's own position restarts it.
    skipTo(position) {
      const state = load();
      const index = position - 1;
      if (!Number.isInteger(position) || index < 0 || index >= state.queue.length) return null;
      stopPlayback();
      save(jumpTo(state, index));
      startCurrent();
      return { entry: state.queue[index], dropped: state.loop || state.shuffle ? 0 : index };
    },

    // Toggles; returns "paused" | "resumed" | null (nothing playing).
    togglePause() {
      if (!playing) return null;
      paused = !paused;
      paused ? output.pause() : output.resume();
      return paused ? "paused" : "resumed";
    },

    // Removes the track at `index` outright; removing the current one moves on.
    remove(index) {
      const removingCurrent = index === load().cursor && playing;
      if (removingCurrent) stopPlayback();
      save(removeAt(load(), index));
      if (removingCurrent) startCurrent();
    },

    removeAll() {
      stopPlayback();
      save(clearQueue(load()));
      if (connected) armIdleTimer();
    },

    setLoop: (on) => save(setLoop(load(), on)),
    setShuffle: (on) => save(setShuffle(load(), on)),
    setPlayCall: (on) => save(setPlayCall(load(), on)),

    // Persistent: stay in the call whatever happens (empty queue, nobody else
    // there). Switching it on cancels any pending auto-leave; switching it off
    // re-applies the normal rules right away.
    setPersistent(on) {
      const state = save(setPersistent(load(), on));
      if (on) {
        clearTimers();
      } else if (connected) {
        if (!playing) armIdleTimer();
        session.evaluateCompany();
      }
      return state;
    },

    // Called when someone joins/leaves the call: leaves after a grace period
    // if the bot is left alone, and cancels that if someone comes back.
    evaluateCompany() {
      if (!connected) return;
      if (load().persistent) {
        clearTimer(aloneTimer);
        aloneTimer = null;
        return;
      }
      if (output.humanCount() === 0) {
        if (!aloneTimer) aloneTimer = setTimer(() => leaveBecause("Left the call — everyone else left. The queue is kept."), timing.aloneLeaveMs);
      } else {
        clearTimer(aloneTimer);
        aloneTimer = null;
      }
    },

    // The connection was closed from outside (kicked, channel deleted).
    handleClosed() {
      token++;
      playing = paused = connected = false;
      clearTimers();
    },

    // Length of a converted track in ms, or undefined if not known yet.
    durationOf(entry) {
      try {
        return getCache().durationOf(entry);
      } catch {
        return undefined;
      }
    },
  };

  output.onClosed(() => session.handleClosed());
  return session;
}
