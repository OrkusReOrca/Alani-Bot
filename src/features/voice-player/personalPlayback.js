// Where a personal queue ("On account" in the web app) is in its song, shared by every device of that
// account: playing or paused, the position, and a revision number that goes up with every change. Each
// device asks for it every couple of seconds and follows it, so a phone and a computer play the same
// song at the same spot, and a pause or skip on one happens on the other.
//
// Pure functions over { playing, positionMs, updatedAt, rev, waiting } (updatedAt and now in ms). While
// playing, the position moves on with the clock — except while `waiting`: a song that just became the
// current one stands at the start until a device has actually started it ("started"), so no device
// chases a clock that ran while the song was still being converted, sent and loaded.

export const stoppedPlayback = () => ({ playing: false, positionMs: 0, updatedAt: 0, rev: 0, waiting: false });

/** The position right now. */
export const positionAt = (pb, now) => (pb.playing && !pb.waiting ? pb.positionMs + Math.max(0, now - pb.updatedAt) : pb.positionMs);

const change = (pb, now, patch) => ({ ...pb, waiting: false, ...patch, updatedAt: now, rev: pb.rev + 1 });
const validPosition = (ms) => (Number.isFinite(ms) && ms >= 0 ? Math.round(ms) : null);

/** Play from the given position (or from where it is). */
export const play = (pb, now, positionMs) => change(pb, now, { playing: true, positionMs: validPosition(positionMs) ?? positionAt(pb, now) });

/** Pause at the given position (or where it is now). */
export const pause = (pb, now, positionMs) => change(pb, now, { playing: false, positionMs: validPosition(positionMs) ?? positionAt(pb, now) });

/** Jump within the song, keeping playing or paused. */
export const seek = (pb, now, positionMs) => change(pb, now, { positionMs: validPosition(positionMs) ?? 0 });

/** Another song became the current one (or the same one starts again): from the start, waiting for a device. */
export const restartTrack = (pb, now, { playing = pb.playing } = {}) => change(pb, now, { playing, positionMs: 0, waiting: playing });

/** A device started the waiting song (at positionMs): the clock runs from now. Null if it isn't waiting any more. */
export const started = (pb, now, rev, positionMs) => (pb.waiting && rev === pb.rev ? change(pb, now, { positionMs: validPosition(positionMs) ?? pb.positionMs }) : null);

/** Nothing to play any more. */
export const stop = (pb, now) => change(pb, now, { playing: false, positionMs: 0 });

/** What the devices are told. */
export const playbackView = (pb, now) => ({ playing: pb.playing, positionMs: positionAt(pb, now), rev: pb.rev, waiting: pb.waiting, serverTime: now });
