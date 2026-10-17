// The queue rules, as pure functions over a plain state object:
//
//   { queue: [entry, ...], cursor: number, loop, shuffle, playCall, persistent, upNext }
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
// With shuffle on, the track that plays next is drawn ahead of time and kept in
// `upNext` (an index, null otherwise), so players can get it ready (convert it,
// load it) before it is needed. Savers call withUpNext() after every change.
//
// playCall ("Now playing" messages) and persistent (never auto-leave the call)
// aren't about the queue itself: they're per-server switches kept here because
// they're saved and shown alongside loop and shuffle.
//
// Every function returns a NEW state and never mutates its input.

export const isLooping = (state) => state.loop || state.shuffle;

export function emptyState() {
  return { queue: [], cursor: 0, loop: false, shuffle: false, playCall: true, persistent: false, upNext: null };
}

const playableIndexes = (state) => state.queue.map((entry, i) => (entry.skip ? -1 : i)).filter((i) => i >= 0);
const validUpNext = (state) => Number.isInteger(state.upNext) && state.upNext !== state.cursor && Boolean(state.queue[state.upNext]) && !state.queue[state.upNext].skip;

/** Keeps `upNext` drawn while shuffling (null otherwise); a drawn track stays until it plays or goes. */
export function withUpNext(state, random = Math.random) {
  if (!state.shuffle || !currentEntry(state)) return state.upNext == null ? state : { ...state, upNext: null };
  if (validUpNext(state)) return state;
  const others = playableIndexes(state).filter((i) => i !== state.cursor);
  const upNext = others.length ? others[Math.floor(random() * others.length)] : null;
  return upNext === (state.upNext ?? null) ? state : { ...state, upNext };
}

/** The index of the track that plays after the current one, or null (the queue ends, or not drawn yet). */
export function nextIndex(state) {
  if (!currentEntry(state)) return null;
  if (state.shuffle) return validUpNext(state) ? state.upNext : null;
  const count = state.queue.length;
  for (let step = 1; step < (state.loop ? count + 1 : count - state.cursor); step++) {
    const index = (state.cursor + step) % count;
    if (!state.queue[index].skip) return index;
  }
  return null;
}

// An index after `at` gained a neighbour before it (an insert at `at`): it moves down one.
const shiftedForInsert = (index, at) => (Number.isInteger(index) && index >= at ? index + 1 : index ?? null);

/**
 * The index a client meant: `index` if the track there is `fileId` (or no fileId was given), else the
 * nearest index holding that file (the queue changed meanwhile), else null.
 */
export function resolveIndex(state, index, fileId) {
  if (!fileId) return Number.isInteger(index) && state.queue[index] ? index : null;
  if (state.queue[index]?.fileId === fileId) return index;
  let best = null;
  state.queue.forEach((entry, i) => {
    if (entry.fileId === fileId && (best === null || Math.abs(i - index) < Math.abs(best - index))) best = i;
  });
  return best;
}

// The track that is playing / plays next, or null when the queue has ended.
export const currentEntry = (state) => state.queue[state.cursor] ?? null;

export function enqueue(state, entry) {
  return { ...state, queue: [...state.queue, entry] };
}

// Puts `entry` right after the current track (or at the end if there is none).
export function insertNext(state, entry) {
  const at = Math.min(state.cursor + 1, state.queue.length);
  return { ...state, queue: [...state.queue.slice(0, at), entry, ...state.queue.slice(at)], upNext: shiftedForInsert(state.upNext, at) };
}

// Makes `entry` the current track (it takes the cursor's place).
export function enqueueFront(state, entry) {
  const at = Math.min(state.cursor, state.queue.length);
  return { ...state, queue: [...state.queue.slice(0, at), entry, ...state.queue.slice(at)], upNext: shiftedForInsert(state.upNext, at) };
}

// Moves the cursor to `index` (0-based, must be inside the queue). Looping:
// just the cursor. Otherwise everything before `index` is dropped as played.
export function jumpTo(state, index) {
  if (!isLooping(state)) return { ...state, queue: state.queue.slice(index), cursor: 0 };
  return { ...state, cursor: index, upNext: state.upNext === index ? null : state.upNext ?? null };
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

  const playable = playableIndexes(state);
  if (playable.length === 0) return { ...state, cursor: state.queue.length }; // everything is marked skip: the queue has ended
  if (state.shuffle && !inOrder && state.queue.length > 1) {
    if (validUpNext(state)) return { ...state, cursor: state.upNext, upNext: null }; // drawn ahead of time
    const others = playable.filter((i) => i !== state.cursor);
    return { ...state, cursor: others.length ? others[Math.floor(random() * others.length)] : state.cursor, upNext: null };
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
  const follow = (index) => {
    if (index === from) return to;
    if (from < index && to >= index) return index - 1;
    if (from > index && to <= index) return index + 1;
    return index;
  };
  return { ...state, queue, cursor: follow(state.cursor), upNext: Number.isInteger(state.upNext) ? follow(state.upNext) : null };
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
  const upNext = !Number.isInteger(state.upNext) || state.upNext === index ? null : state.upNext > index ? state.upNext - 1 : state.upNext;
  return { ...state, queue, cursor, upNext };
}

export function clearQueue(state) {
  return { ...state, queue: [], cursor: 0, upNext: null };
}

export const setLoop = (state, on) => ({ ...state, loop: on });
export const setShuffle = (state, on) => ({ ...state, shuffle: on });
export const setPlayCall = (state, on) => ({ ...state, playCall: on });
export const setPersistent = (state, on) => ({ ...state, persistent: on });
