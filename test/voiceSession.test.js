import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSession, track, fakeCache, memoryStore, TIMING } from "./helpers/voiceFakes.js";

test("add while connected starts the first track; later ones wait; a finished track is removed and the next starts", async () => {
  const t = makeSession();
  await t.session.join("vc1");

  assert.deepEqual(t.session.add(track("A")), { position: 1, startsNow: true });
  assert.deepEqual(t.session.add(track("B")), { position: 2, startsNow: false });
  assert.deepEqual(t.session.add(track("C")), { position: 3, startsNow: false });
  assert.deepEqual(t.cache.opened, ["A"]);
  assert.equal(t.session.isPlaying(), true);

  t.output.finishTrack();
  assert.deepEqual(t.names(), ["B", "C"]);
  assert.deepEqual(t.cache.opened, ["A", "B"]);
  assert.deepEqual(t.announcements, ["Now playing: **A**", "Now playing: **B**"]);

  t.output.finishTrack();
  t.output.finishTrack();
  assert.deepEqual(t.names(), []);
  assert.equal(t.session.isPlaying(), false);
});

test("the queue is pinned in the cache so queued tracks are never evicted", async () => {
  const t = makeSession();
  await t.session.join("vc1");
  t.session.add(track("A"));
  t.session.add(track("B"));
  assert.deepEqual(t.cache.pinned, ["key-A", "key-B"]);
});

test("loop: the list stays in the order added; only the current-song pointer moves, and it wraps", async () => {
  const t = makeSession();
  await t.session.join("vc1");
  t.session.add(track("A"));
  t.session.add(track("B"));
  t.session.setLoop(true);

  t.output.finishTrack();
  assert.deepEqual(t.names(), ["A", "B"]); // never reordered
  assert.equal(t.store.loadState("g1").cursor, 1);
  t.output.finishTrack();
  assert.deepEqual(t.names(), ["A", "B"]);
  assert.equal(t.store.loadState("g1").cursor, 0);
  assert.deepEqual(t.cache.opened, ["A", "B", "A"]);
});

test("shuffle (loop setting off) still loops: the pointer jumps to a random other track and the list is NEVER reordered", async () => {
  const t = makeSession({ random: () => 0.99 }); // always the last candidate
  await t.session.join("vc1");
  for (const n of ["A", "B", "C", "D"]) t.session.add(track(n));
  t.session.setShuffle(true);

  t.output.finishTrack();
  assert.equal(t.store.loadState("g1").cursor, 3); // D
  assert.equal(t.cache.opened.at(-1), "D");
  t.output.finishTrack();
  assert.equal(t.store.loadState("g1").cursor, 2); // random: last candidate among A, B, C
  assert.deepEqual(t.names(), ["A", "B", "C", "D"]); // the list never changed
  assert.equal(t.store.loadState("g1").loop, false);
});

test("without loop, a finished track is removed from the list (the one rule that does change it)", async () => {
  const t = makeSession();
  await t.session.join("vc1");
  for (const n of ["A", "B", "C"]) t.session.add(track(n));
  t.output.finishTrack();
  assert.deepEqual(t.names(), ["B", "C"]);
  assert.equal(t.store.loadState("g1").cursor, 0);
});

test("leaving and rejoining resumes the saved queue from the start of its first track", async () => {
  const store = memoryStore();
  const first = makeSession({ store });
  await first.session.join("vc1");
  first.session.add(track("A"));
  first.session.add(track("B"));
  await first.session.leave();

  assert.equal(first.session.isConnected(), false);
  assert.equal(first.session.isPlaying(), false);
  assert.deepEqual(first.names(), ["A", "B"]); // kept

  // Even a brand-new session (e.g. after a bot restart) picks the queue up.
  const second = makeSession({ store, cache: fakeCache() });
  assert.deepEqual(await second.session.join("vc9"), { resumed: true });
  assert.deepEqual(second.cache.opened, ["A"]);
  assert.deepEqual(second.names(), ["A", "B"]);
});

test("adding while not in a call only saves; joining then starts it", async () => {
  const t = makeSession();
  assert.deepEqual(t.session.add(track("A")), { position: 1, startsNow: false });
  assert.equal(t.output.log.includes("play"), false);
  await t.session.join("vc1");
  assert.deepEqual(t.cache.opened, ["A"]);
});

test("force plays the new track next and cuts the current one short — current dropped without loop, kept in place with loop", async () => {
  const t = makeSession();
  await t.session.join("vc1");
  t.session.add(track("A"));
  t.session.add(track("B"));
  t.session.force(track("X"));
  assert.deepEqual(t.names(), ["X", "B"]);
  assert.equal(t.cache.opened.at(-1), "X");

  t.session.setLoop(true);
  t.session.force(track("Y")); // inserted right after X (the current one), which stays in the list
  assert.deepEqual(t.names(), ["X", "Y", "B"]);
  assert.equal(t.store.loadState("g1").cursor, 1);
  assert.equal(t.cache.opened.at(-1), "Y");
});

test("force during shuffle still plays the forced track, not a random one, and doesn't reorder the list", async () => {
  const t = makeSession({ random: () => 0.99 });
  await t.session.join("vc1");
  for (const n of ["A", "B", "C"]) t.session.add(track(n));
  t.session.setShuffle(true);
  t.session.force(track("X"));
  assert.deepEqual(t.names(), ["A", "X", "B", "C"]);
  assert.equal(t.cache.opened.at(-1), "X");
});

test("force with nothing playing puts the track at the front", async () => {
  const t = makeSession();
  t.session.add(track("A")); // saved, not connected
  t.session.force(track("X"));
  assert.deepEqual(t.names(), ["X", "A"]);
  await t.session.join("vc1");
  assert.deepEqual(t.cache.opened, ["X"]);
});

test("skip retires the current track by the same rules and starts the next", async () => {
  const t = makeSession();
  await t.session.join("vc1");
  t.session.add(track("A"));
  t.session.add(track("B"));

  assert.equal(t.session.skip().name, "A");
  assert.deepEqual(t.names(), ["B"]);
  assert.equal(t.cache.opened.at(-1), "B");
  assert.equal(makeSession().session.skip(), null);
});

test("skipTo jumps to a position: with loop it only moves the pointer, without loop the tracks before it are dropped", async () => {
  const looping = makeSession();
  await looping.session.join("vc1");
  for (const n of ["A", "B", "C", "D", "E"]) looping.session.add(track(n));
  looping.session.setLoop(true);

  assert.deepEqual(looping.session.skipTo(4), { entry: looping.store.loadState("g1").queue[3], dropped: 0 });
  assert.deepEqual(looping.names(), ["A", "B", "C", "D", "E"]);
  assert.equal(looping.store.loadState("g1").cursor, 3);
  assert.equal(looping.cache.opened.at(-1), "D");
  looping.session.skipTo(1); // going back works too while looping
  assert.equal(looping.cache.opened.at(-1), "A");

  const plain = makeSession();
  await plain.session.join("vc1");
  for (const n of ["A", "B", "C", "D", "E"]) plain.session.add(track(n));
  const result = plain.session.skipTo(4);
  assert.equal(result.entry.name, "D");
  assert.equal(result.dropped, 3);
  assert.deepEqual(plain.names(), ["D", "E"]);
  assert.equal(plain.cache.opened.at(-1), "D");
});

test("skipTo refuses a position that isn't in the queue and changes nothing", async () => {
  const t = makeSession();
  await t.session.join("vc1");
  t.session.add(track("A"));
  t.session.add(track("B"));
  for (const bad of [0, 3, -1, 1.5, NaN]) assert.equal(t.session.skipTo(bad), null, String(bad));
  assert.deepEqual(t.names(), ["A", "B"]);
  assert.equal(t.session.isPlaying(), true);
  assert.deepEqual(t.cache.opened, ["A"]); // nothing restarted
});

test("the current-song pointer survives leaving and a brand-new session: rejoining resumes at that track", async () => {
  const store = memoryStore();
  const first = makeSession({ store });
  await first.session.join("vc1");
  for (const n of ["A", "B", "C"]) first.session.add(track(n));
  first.session.setLoop(true);
  first.output.finishTrack(); // now on B
  first.output.finishTrack(); // now on C
  await first.session.leave();

  const second = makeSession({ store, cache: fakeCache() });
  assert.deepEqual(await second.session.join("vc9"), { resumed: true });
  assert.deepEqual(second.cache.opened, ["C"]);
  assert.deepEqual(second.names(), ["A", "B", "C"]);
});

test("the queue ending leaves nothing current; a track added afterwards plays right away", async () => {
  const t = makeSession();
  await t.session.join("vc1");
  t.session.add(track("A"));
  t.output.finishTrack();
  assert.equal(t.session.isPlaying(), false);

  assert.deepEqual(t.session.add(track("B")), { position: 1, startsNow: true });
  assert.deepEqual(t.cache.opened, ["A", "B"]);
});

test("pause toggles, and reports nothing when nothing is playing", async () => {
  const t = makeSession();
  assert.equal(t.session.togglePause(), null);
  await t.session.join("vc1");
  t.session.add(track("A"));
  assert.equal(t.session.togglePause(), "paused");
  assert.equal(t.session.isPaused(), true);
  assert.equal(t.session.togglePause(), "resumed");
  assert.deepEqual(t.output.log.filter((l) => l === "pause" || l === "resume"), ["pause", "resume"]);
});

test("remove: another track just disappears; the current one is stopped and the next starts, even when looping", async () => {
  const t = makeSession();
  await t.session.join("vc1");
  for (const n of ["A", "B", "C"]) t.session.add(track(n));
  t.session.setLoop(true);

  t.session.remove(2);
  assert.deepEqual(t.names(), ["A", "B"]);
  assert.equal(t.cache.opened.length, 1);

  t.session.remove(0);
  assert.deepEqual(t.names(), ["B"]); // gone for good, not rotated
  assert.equal(t.cache.opened.at(-1), "B");
});

test("removeall clears the queue and stops playing but stays in the call", async () => {
  const t = makeSession();
  await t.session.join("vc1");
  t.session.add(track("A"));
  t.session.add(track("B"));
  t.session.removeAll();
  assert.deepEqual(t.names(), []);
  assert.equal(t.session.isPlaying(), false);
  assert.equal(t.session.isConnected(), true);
});

test("a late finish/error event from a track that was already skipped is ignored", async () => {
  const t = makeSession();
  await t.session.join("vc1");
  t.session.add(track("A"));
  t.session.add(track("B"));
  t.session.add(track("C"));
  const [playbackOfA] = t.output.playbacks;

  t.session.skip(); // B is now playing
  playbackOfA.onFinish(); // A's stale "finished" arrives late
  playbackOfA.onError(new Error("stale"));

  assert.deepEqual(t.names(), ["B", "C"]); // nothing was advanced or dropped
  assert.equal(t.session.isPlaying(), true);
  assert.equal(t.announcements.some((a) => a.includes("Couldn't play")), false);
});

test("a track that fails to play is dropped (even when looping) and the next one starts", async () => {
  const t = makeSession();
  await t.session.join("vc1");
  t.session.add(track("Broken"));
  t.session.add(track("Good"));
  t.session.setLoop(true);

  t.output.failTrack(new Error("decode error"));
  assert.deepEqual(t.names(), ["Good"]);
  assert.match(t.announcements.join("\n"), /Couldn't play \*\*Broken\*\*: decode error — skipping it/);
  assert.equal(t.cache.opened.at(-1), "Good");
});

test("a track that can't even be opened is dropped too", async () => {
  const cache = fakeCache();
  cache.open = () => {
    throw new Error("ffmpeg isn't available");
  };
  const t = makeSession({ cache });
  await t.session.join("vc1");
  t.session.add(track("A"));
  assert.deepEqual(t.names(), []);
  assert.match(t.announcements.join("\n"), /ffmpeg isn't available/);
});

test("idle: after the queue runs out the bot leaves after 5 minutes, keeping the (empty) state", async () => {
  const t = makeSession();
  await t.session.join("vc1");
  assert.equal(t.timers.has(TIMING.idleLeaveMs), true);

  t.session.add(track("A"));
  assert.equal(t.timers.has(TIMING.idleLeaveMs), false); // playing: no idle timer
  t.output.finishTrack();
  assert.equal(t.timers.has(TIMING.idleLeaveMs), true);

  await t.timers.fire(TIMING.idleLeaveMs);
  assert.equal(t.session.isConnected(), false);
  assert.match(t.announcements.at(-1), /nothing was playing for 5 minutes/);
});

test("alone in the call: leaves after a minute; someone returning cancels it; the queue is kept", async () => {
  const t = makeSession();
  await t.session.join("vc1");
  t.session.add(track("A"));

  t.output.setHumans(0);
  t.session.evaluateCompany();
  assert.equal(t.timers.has(TIMING.aloneLeaveMs), true);
  t.output.setHumans(1);
  t.session.evaluateCompany();
  assert.equal(t.timers.has(TIMING.aloneLeaveMs), false);

  t.output.setHumans(0);
  t.session.evaluateCompany();
  await t.timers.fire(TIMING.aloneLeaveMs);
  assert.equal(t.session.isConnected(), false);
  assert.deepEqual(t.names(), ["A"]);
  assert.match(t.announcements.at(-1), /everyone else left/);
});

test("being disconnected from outside resets the session but keeps the queue", async () => {
  const t = makeSession();
  await t.session.join("vc1");
  t.session.add(track("A"));
  t.output.close();
  assert.equal(t.session.isConnected(), false);
  assert.equal(t.session.isPlaying(), false);
  assert.deepEqual(t.names(), ["A"]);
});

test("a failed join leaves the session disconnected", async () => {
  const t = makeSession();
  await assert.rejects(t.session.join("bad"), /timed out/);
  assert.equal(t.session.isConnected(), false);
});

test("PlayCall off silences only the 'Now playing' message — for that server alone — and takes effect immediately", async () => {
  const store = memoryStore();
  const quiet = makeSession({ store, guildId: "quiet" });
  const loud = makeSession({ store, guildId: "loud" });
  await quiet.session.join("vc1");
  await loud.session.join("vc1");

  quiet.session.setPlayCall(false);
  quiet.session.add(track("A"));
  quiet.session.add(track("B"));
  loud.session.add(track("A"));

  assert.deepEqual(quiet.announcements, []); // A started silently
  assert.deepEqual(loud.announcements, ["Now playing: **A**"]); // the other server is unaffected
  assert.equal(quiet.session.isPlaying(), true);

  quiet.output.failTrack(new Error("decode error")); // problems still post
  assert.match(quiet.announcements.join("\n"), /Couldn't play \*\*A\*\*/);
  assert.equal(quiet.announcements.some((a) => a.startsWith("Now playing")), false); // B started silently

  quiet.session.setPlayCall(true);
  quiet.session.add(track("C"));
  quiet.output.finishTrack(); // B ends, C starts
  assert.match(quiet.announcements.at(-1), /Now playing: \*\*C\*\*/);

  // The switch survives leaving and a brand-new session (it lives in the saved state).
  quiet.session.setPlayCall(false);
  await quiet.session.leave();
  const reborn = makeSession({ store, guildId: "quiet" });
  await reborn.session.join("vc1");
  assert.deepEqual(reborn.announcements, []);
  assert.equal(store.loadState("quiet").playCall, false);
});

test("Persistent: the bot never leaves — not when the queue runs out, not when everyone leaves — and it's per server", async () => {
  const store = memoryStore();
  const stay = makeSession({ store, guildId: "stay" });
  const leave = makeSession({ store, guildId: "leave" });
  await stay.session.join("vc1");
  await leave.session.join("vc1");

  stay.session.setPersistent(true);
  assert.equal(stay.timers.count(), 0); // the idle timer armed at join was cancelled

  // The queue runs out: no idle timer for the persistent server, one for the other.
  stay.session.add(track("A"));
  leave.session.add(track("A"));
  stay.output.finishTrack();
  leave.output.finishTrack();
  assert.equal(stay.timers.has(TIMING.idleLeaveMs), false);
  assert.equal(leave.timers.has(TIMING.idleLeaveMs), true);

  // Everyone leaves the call.
  stay.output.setHumans(0);
  stay.session.evaluateCompany();
  assert.equal(stay.timers.has(TIMING.aloneLeaveMs), false);
  assert.equal(stay.session.isConnected(), true);

  assert.equal(stay.output.log.includes("leave"), false); // it never asked the output to leave
});

test("Persistent turned off re-applies the normal rules at once; turned on cancels a pending leave", async () => {
  const t = makeSession();
  await t.session.join("vc1"); // idle: the idle timer is pending
  assert.equal(t.timers.has(TIMING.idleLeaveMs), true);

  t.session.setPersistent(true);
  assert.equal(t.timers.count(), 0);

  t.output.setHumans(0); // alone while persistent: nothing happens
  t.session.evaluateCompany();
  assert.equal(t.timers.count(), 0);

  t.session.setPersistent(false); // now both rules apply immediately
  assert.equal(t.timers.has(TIMING.idleLeaveMs), true);
  assert.equal(t.timers.has(TIMING.aloneLeaveMs), true);

  t.session.setPersistent(true); // and back on cancels them again
  assert.equal(t.timers.count(), 0);
  assert.equal(t.session.isConnected(), true);
});

test("a persistent session still leaves when told to, and keeps its setting", async () => {
  const t = makeSession();
  await t.session.join("vc1");
  t.session.setPersistent(true);
  await t.session.leave();
  assert.equal(t.session.isConnected(), false);
  assert.equal(t.store.loadState("g1").persistent, true);
});

test("remove keeps the pointer on the same track: removing an earlier one shifts it, removing the current one moves on in place", async () => {
  const t = makeSession();
  await t.session.join("vc1");
  for (const n of ["A", "B", "C", "D"]) t.session.add(track(n));
  t.session.setLoop(true);
  t.session.skipTo(3); // current: C

  t.session.remove(0); // A, before the current one
  assert.deepEqual(t.names(), ["B", "C", "D"]);
  assert.equal(t.store.loadState("g1").cursor, 1); // still C
  assert.equal(t.session.isPlaying(), true);
  assert.equal(t.cache.opened.at(-1), "C"); // C was not restarted

  t.session.remove(1); // the current track itself
  assert.deepEqual(t.names(), ["B", "D"]);
  assert.equal(t.cache.opened.at(-1), "D"); // D slid into its place and plays
});
