// The queue rules, as pure functions over a plain state object:
//
//   { queue: [entry, ...], loop: boolean, shuffle: boolean, playCall: boolean, persistent: boolean }
//
// playCall ("Now playing" messages) and persistent (never auto-leave the call)
// aren't about the queue itself: they're per-server switches kept here because
// they're saved and shown alongside loop and shuffle.
//
// queue[0] is ALWAYS the current track — the one playing, or the one that
// plays next. A track that finishes is removed, unless looping (or shuffling,
// which implies looping): then it goes to the back of the queue instead. With
// shuffle on, the next track is picked at random from the rest.
//
// Every function returns a NEW state and never mutates its input.

export const isLooping = (state) => state.loop || state.shuffle;

export function emptyState() {
  return { queue: [], loop: false, shuffle: false, playCall: true, persistent: false };
}

export function enqueue(state, entry) {
  return { ...state, queue: [...state.queue, entry] };
}

// Puts `entry` right after the current track.
export function insertNext(state, entry) {
  const [current, ...rest] = state.queue;
  return { ...state, queue: current ? [current, entry, ...rest] : [entry] };
}

// Puts `entry` at the very front (it becomes the current/next track).
export function enqueueFront(state, entry) {
  return { ...state, queue: [entry, ...state.queue] };
}

// The current track is over (finished or skipped): retire it and move on.
// `random` is () => number in [0, 1), injectable for tests. inOrder: take the
// next track in queue order even when shuffling (used when a specific track
// was just placed next, i.e. force play).
export function advance(state, random = Math.random, { inOrder = false } = {}) {
  if (state.queue.length === 0) return state;
  const [finished, ...rest] = state.queue;
  if (!isLooping(state)) return { ...state, queue: rest };

  if (state.shuffle && !inOrder && rest.length > 1) {
    const pick = Math.floor(random() * rest.length);
    const [chosen] = rest.splice(pick, 1);
    return { ...state, queue: [chosen, ...rest, finished] };
  }
  return { ...state, queue: [...rest, finished] };
}

// Removes the track at `index` outright (no looping — it's gone).
export function removeAt(state, index) {
  return { ...state, queue: state.queue.filter((_, i) => i !== index) };
}

export function clearQueue(state) {
  return { ...state, queue: [] };
}

export const setLoop = (state, on) => ({ ...state, loop: on });
export const setShuffle = (state, on) => ({ ...state, shuffle: on });
export const setPlayCall = (state, on) => ({ ...state, playCall: on });
export const setPersistent = (state, on) => ({ ...state, persistent: on });
