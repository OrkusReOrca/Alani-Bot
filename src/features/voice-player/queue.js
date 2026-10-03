// The queue rules, as pure functions over a plain state object:
//
//   { queue: [entry, ...], cursor: number, loop, shuffle, playCall, persistent }
//
// The queue is a STATIC list, in the order tracks were added. `cursor` is the
// index of the current track — the one playing, or the one that plays next.
// Moving on while looping (or shuffling, which implies looping) only moves the
// cursor; the list itself is never reordered or rewritten. That keeps the saved
// state (and its change log, which feeds the cloud backup) tiny: a track change
// is one small number.
//
// Without looping, a track that has been played is dropped from the list as
// the queue moves on, along with anything before it (it was played or skipped),
// so the cursor is 0 whenever it moves on. cursor === queue.length means "the
// queue has ended"; a track added then becomes the current one.
//
// playCall ("Now playing" messages) and persistent (never auto-leave the call)
// aren't about the queue itself: they're per-server switches kept here because
// they're saved and shown alongside loop and shuffle.
//
// Every function returns a NEW state and never mutates its input.

export const isLooping = (state) => state.loop || state.shuffle;

export function emptyState() {
  return { queue: [], cursor: 0, loop: false, shuffle: false, playCall: true, persistent: false };
}

// The track that is playing / plays next, or null when the queue has ended.
export const currentEntry = (state) => state.queue[state.cursor] ?? null;

export function enqueue(state, entry) {
  return { ...state, queue: [...state.queue, entry] };
}

// Puts `entry` right after the current track (or at the end if there is none).
export function insertNext(state, entry) {
  const at = Math.min(state.cursor + 1, state.queue.length);
  return { ...state, queue: [...state.queue.slice(0, at), entry, ...state.queue.slice(at)] };
}

// Makes `entry` the current track (it takes the cursor's place).
export function enqueueFront(state, entry) {
  const at = Math.min(state.cursor, state.queue.length);
  return { ...state, queue: [...state.queue.slice(0, at), entry, ...state.queue.slice(at)] };
}

// Moves the cursor to `index` (0-based, must be inside the queue). Looping:
// just the cursor. Otherwise everything before `index` is dropped as played.
export function jumpTo(state, index) {
  return isLooping(state) ? { ...state, cursor: index } : { ...state, queue: state.queue.slice(index), cursor: 0 };
}

// The current track is over (finished or skipped): move on.
// `random` is () => number in [0, 1), injectable for tests. inOrder: take the
// next track in list order even when shuffling (used when a specific track
// was just placed next, i.e. force play).
export function advance(state, random = Math.random, { inOrder = false } = {}) {
  if (!currentEntry(state)) return state;

  if (!isLooping(state)) return { ...state, queue: state.queue.slice(state.cursor + 1), cursor: 0 };

  if (state.shuffle && !inOrder && state.queue.length > 1) {
    const others = state.queue.map((_, i) => i).filter((i) => i !== state.cursor);
    return { ...state, cursor: others[Math.floor(random() * others.length)] };
  }
  return { ...state, cursor: (state.cursor + 1) % state.queue.length };
}

// Removes the track at `index` outright. The cursor follows: tracks after the
// removed one slide into its place, and a cursor left past the end wraps to the
// start when looping (otherwise the queue has ended).
export function removeAt(state, index) {
  const queue = state.queue.filter((_, i) => i !== index);
  let cursor = index < state.cursor ? state.cursor - 1 : state.cursor;
  if (cursor >= queue.length) cursor = queue.length > 0 && isLooping(state) ? 0 : queue.length;
  return { ...state, queue, cursor };
}

export function clearQueue(state) {
  return { ...state, queue: [], cursor: 0 };
}

export const setLoop = (state, on) => ({ ...state, loop: on });
export const setShuffle = (state, on) => ({ ...state, shuffle: on });
export const setPlayCall = (state, on) => ({ ...state, playCall: on });
export const setPersistent = (state, on) => ({ ...state, persistent: on });
