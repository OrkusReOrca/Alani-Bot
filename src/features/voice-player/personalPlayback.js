// Where a personal queue ("On account" in the web app) is in its song, shared by every device of that
// account: playing or paused, the position, and a revision number that goes up with every change. Each
// device asks for it every couple of seconds and follows it, so a phone and a computer play the same
// song at the same spot, and a pause or skip on one happens on the other.
//
// Pure functions over { playing, positionMs, updatedAt, rev } (updatedAt and now in ms). While playing,
// the position moves on with the clock.

export const stoppedPlayback = () => ({ playing: false, positionMs: 0, updatedAt: 0, rev: 0 });

/** The position right now. */
export const positionAt = (pb, now) => (pb.playing ? pb.positionMs + Math.max(0, now - pb.updatedAt) : pb.positionMs);

const change = (pb, now, patch) => ({ ...pb, ...patch, updatedAt: now, rev: pb.rev + 1 });
const validPosition = (ms) => (Number.isFinite(ms) && ms >= 0 ? Math.round(ms) : null);

/** Play from the given position (or from where it is). */
export const play = (pb, now, positionMs) => change(pb, now, { playing: true, positionMs: validPosition(positionMs) ?? positionAt(pb, now) });

/** Pause at the given position (or where it is now). */
export const pause = (pb, now, positionMs) => change(pb, now, { playing: false, positionMs: validPosition(positionMs) ?? positionAt(pb, now) });

/** Jump within the song, keeping playing or paused. */
export const seek = (pb, now, positionMs) => change(pb, now, { positionMs: validPosition(positionMs) ?? 0 });

/** Another song became the current one (or the same one starts again): from the start. */
export const restartTrack = (pb, now, { playing = pb.playing } = {}) => change(pb, now, { playing, positionMs: 0 });

/** Nothing to play any more. */
export const stop = (pb, now) => change(pb, now, { playing: false, positionMs: 0 });

/** What the devices are told. */
export const playbackView = (pb, now) => ({ playing: pb.playing, positionMs: positionAt(pb, now), rev: pb.rev, serverTime: now });
