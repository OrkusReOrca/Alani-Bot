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
// A track can be marked "skip" (entry.skip = true): it stays in the list, crossed
// out, and moving on passes over it.
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

// The current track is over (finished or skipped): move on, passing over tracks
// marked "skip". `random` is () => number in [0, 1), injectable for tests.
// inOrder: take the next track in list order even when shuffling (used when a
// specific track was just placed next, i.e. force play).
export function advance(state, random = Math.random, { inOrder = false } = {}) {
  if (!currentEntry(state)) return state;

  if (!isLooping(state)) {
    let rest = state.queue.slice(state.cursor + 1);
    while (rest[0]?.skip) rest = rest.slice(1);
    return { ...state, queue: rest, cursor: 0 };
  }

  const playable = state.queue.map((entry, i) => (entry.skip ? -1 : i)).filter((i) => i >= 0);
  if (playable.length === 0) return { ...state, cursor: state.queue.length }; // everything is marked skip: the queue has ended
  if (state.shuffle && !inOrder && state.queue.length > 1) {
    const others = playable.filter((i) => i !== state.cursor);
    return { ...state, cursor: others.length ? others[Math.floor(random() * others.length)] : state.cursor };
  }
  for (let step = 1; step <= state.queue.length; step++) {
    const index = (state.cursor + step) % state.queue.length;
    if (!state.queue[index].skip) return { ...state, cursor: index };
  }
  return state;
}

// The track before the current one (looping only: without looping, played
// tracks are gone), passing over tracks marked "skip". null if there is none.
export function previousIndex(state) {
  if (!isLooping(state) || state.queue.length < 2) return null;
  for (let step = 1; step < state.queue.length; step++) {
    const index = (state.cursor - step + state.queue.length) % state.queue.length;
    if (!state.queue[index].skip) return index;
  }
  return null;
}

// Moves the track at `from` to `to` (both 0-based); the cursor stays on the same track.
export function moveEntry(state, from, to) {
  const n = state.queue.length;
  if (![from, to].every((i) => Number.isInteger(i) && i >= 0 && i < n) || from === to) return state;
  const queue = [...state.queue];
  const [entry] = queue.splice(from, 1);
  queue.splice(to, 0, entry);
  let cursor = state.cursor;
  if (cursor === from) cursor = to;
  else if (from < cursor && to >= cursor) cursor -= 1;
  else if (from > cursor && to <= cursor) cursor += 1;
  return { ...state, queue, cursor };
}

// Marks (or unmarks) the track at `index` to be passed over.
export function setSkip(state, index, on) {
  if (!state.queue[index]) return state;
  const { skip, ...rest } = state.queue[index];
  const entry = on ? { ...rest, skip: true } : rest;
  return { ...state, queue: state.queue.map((e, i) => (i === index ? entry : e)) };
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
