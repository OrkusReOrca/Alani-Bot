// Where a radio station (station.js) is in its song: { playing, positionMs, updatedAt, rev, waiting, playId,
// actionRev }.
// The bot runs this clock: while playing, the position moves on with time; when a song ends, the station
// moves to the next one by itself (at the moment the song ended).
//   waiting  the current song isn't converted yet: it stands at its start until it is
//   playId   counts song starts (a song started again, e.g. looping one song, is a new play), so devices
//            know when to start a song from the beginning
//   rev      goes up with every change
//   actionRev the rev of the last change somebody made (a control); changes the clock made by itself (a song
//            ended, a song became ready) leave it, so devices know when to line up closely
// Pure functions; updatedAt and `now` / `at` in ms.

export const stoppedPlayback = () => ({ playing: false, positionMs: 0, updatedAt: 0, rev: 0, waiting: false, playId: 0, actionRev: 0 });

/** The position right now. */
export const positionAt = (pb, now) => (pb.playing && !pb.waiting ? pb.positionMs + Math.max(0, now - pb.updatedAt) : pb.positionMs);

const change = (pb, now, patch) => ({ ...pb, ...patch, updatedAt: now, rev: pb.rev + 1 });
const validPosition = (ms) => (Number.isFinite(ms) && ms >= 0 ? Math.round(ms) : null);

/** Play from the given position (or from where it is). */
export const play = (pb, now, positionMs) => change(pb, now, { playing: true, positionMs: validPosition(positionMs) ?? positionAt(pb, now) });

/** Pause at the given position (or where it is now). */
export const pause = (pb, now, positionMs) => change(pb, now, { playing: false, positionMs: validPosition(positionMs) ?? positionAt(pb, now) });

/** Jump within the song, keeping playing or paused. */
export const seek = (pb, now, positionMs) => change(pb, now, { positionMs: validPosition(positionMs) ?? 0 });

/** A song starts (another one, or the same one again) at `at`: from 0, a new play; waits if it isn't ready. */
export const restartTrack = (pb, at, { playing = pb.playing, ready = true } = {}) => change(pb, at, { playing, positionMs: 0, waiting: !ready, playId: pb.playId + 1 });

/** The waiting song is ready now: its clock starts. */
export const ready = (pb, now) => (pb.waiting ? change(pb, now, { waiting: false }) : pb);

/** Nothing to play any more. */
export const stop = (pb, at) => change(pb, at, { playing: false, positionMs: 0, waiting: false });

/** What the devices are told. */
export const playbackView = (pb, now) => ({ playing: pb.playing, positionMs: positionAt(pb, now), rev: pb.rev, actionRev: pb.actionRev ?? 0, playId: pb.playId, waiting: pb.waiting, serverTime: now });

/** A control changed it (devices line up closely with it). */
export const byAction = (pb) => ({ ...pb, actionRev: pb.rev });
