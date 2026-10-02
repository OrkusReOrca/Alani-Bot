import { test } from "node:test";
import assert from "node:assert/strict";
import { matchByName, normalizeName, cleanQuery } from "../src/features/voice-player/match.js";
import { emptyState, enqueue, enqueueFront, insertNext, advance, removeAt, clearQueue, setLoop, setShuffle, setPlayCall, isLooping } from "../src/features/voice-player/queue.js";
import { formatDuration, describeSettings, describeQueue } from "../src/features/voice-player/format.js";
import { loadState, saveState, voiceDb } from "../src/features/voice-player/stateStore.js";
import { isPlayableFile } from "../src/features/voice-player/config.js";

const track = (name) => ({ key: name, name });
const stateOf = (names, extra = {}) => ({ ...emptyState(), queue: names.map(track), ...extra });
const names = (state) => state.queue.map((t) => t.name);

// ---------- matching ----------
test("name matching ignores case and extension, and accepts a unique partial name", () => {
  const files = [{ name: "Rain Sounds.mp3" }, { name: "Rainbow Road.mp3" }, { name: "Lofi Mix.wav" }];
  const find = (q) => matchByName(files, q, (f) => f.name);

  assert.equal(find("rain sounds").item.name, "Rain Sounds.mp3");
  assert.equal(find("RAIN SOUNDS.MP3").item.name, "Rain Sounds.mp3");
  assert.equal(find("lofi").item.name, "Lofi Mix.wav");
  assert.equal(find('"lofi mix"').item.name, "Lofi Mix.wav"); // quotes tolerated
  assert.equal(find("rain").status, "many"); // matches two
  assert.deepEqual(find("rain").items.map((f) => f.name), ["Rain Sounds.mp3", "Rainbow Road.mp3"]);
  assert.equal(find("rainbow").item.name, "Rainbow Road.mp3");
  assert.equal(find("jazz").status, "none");
  assert.equal(find("   ").status, "none");
});

test("an exact name beats a partial one, and a track queued twice matches its first copy", () => {
  const items = [{ name: "Song.mp3" }, { name: "Song Remix.mp3" }, { name: "Song.mp3" }];
  const match = matchByName(items, "song", (i) => i.name);
  assert.equal(match.status, "one");
  assert.equal(match.item, items[0]);
});

test("normalizeName and cleanQuery", () => {
  assert.equal(normalizeName("  My   Song.FLAC "), "my song");
  assert.equal(normalizeName("v1.2 mix"), "v1.2 mix"); // "2 mix" isn't an extension
  assert.equal(cleanQuery(" 'x y' "), "x y");
});

test("playable files: audio/video by mime type, or by extension when Drive says octet-stream", () => {
  assert.equal(isPlayableFile({ name: "a.mp3", mimeType: "audio/mpeg" }), true);
  assert.equal(isPlayableFile({ name: "clip", mimeType: "video/mp4" }), true);
  assert.equal(isPlayableFile({ name: "a.flac", mimeType: "application/octet-stream" }), true);
  assert.equal(isPlayableFile({ name: "notes.txt", mimeType: "text/plain" }), false);
  assert.equal(isPlayableFile({ name: "doc", mimeType: "application/vnd.google-apps.document" }), false);
});

// ---------- queue rules ----------
test("without loop, a finished track is removed", () => {
  assert.deepEqual(names(advance(stateOf(["a", "b", "c"]))), ["b", "c"]);
  assert.deepEqual(names(advance(stateOf(["a"]))), []);
  assert.deepEqual(names(advance(emptyState())), []);
});

test("with loop, a finished track goes to the back", () => {
  assert.deepEqual(names(advance(stateOf(["a", "b", "c"], { loop: true }))), ["b", "c", "a"]);
  assert.deepEqual(names(advance(stateOf(["a"], { loop: true }))), ["a"]);
});

test("shuffle implies looping and picks the next track at random from the rest", () => {
  const shuffled = stateOf(["a", "b", "c", "d"], { shuffle: true });
  assert.equal(isLooping(shuffled), true);
  assert.equal(shuffled.loop, false); // the two settings stay separate

  assert.deepEqual(names(advance(shuffled, () => 0)), ["b", "c", "d", "a"]); // picks rest[0]
  assert.deepEqual(names(advance(shuffled, () => 0.99)), ["d", "b", "c", "a"]); // picks rest[2]
  assert.deepEqual(names(advance(shuffled, () => 0.5, { inOrder: true })), ["b", "c", "d", "a"]);
});

test("insertNext, enqueueFront, removeAt, clearQueue and the setting toggles", () => {
  const base = stateOf(["a", "b"]);
  assert.deepEqual(names(insertNext(base, track("x"))), ["a", "x", "b"]);
  assert.deepEqual(names(insertNext(emptyState(), track("x"))), ["x"]);
  assert.deepEqual(names(enqueueFront(base, track("x"))), ["x", "a", "b"]);
  assert.deepEqual(names(enqueue(base, track("x"))), ["a", "b", "x"]);
  assert.deepEqual(names(removeAt(base, 0)), ["b"]);
  assert.deepEqual(names(clearQueue(base)), []);
  assert.equal(setLoop(base, true).loop, true);
  assert.equal(setShuffle(base, true).shuffle, true);
  assert.equal(emptyState().playCall, true); // on by default
  assert.equal(setPlayCall(base, false).playCall, false);
  assert.deepEqual(names(base), ["a", "b"]); // never mutated
});

// ---------- formatting ----------
test("durations", () => {
  assert.equal(formatDuration(83_000), "1:23");
  assert.equal(formatDuration(3_723_000), "1:02:03");
  assert.equal(formatDuration(5_000), "0:05");
  assert.equal(formatDuration(undefined), "length unknown yet");
});

test("settings show loop as on-because-of-shuffle while keeping the two separate, plus PlayCall", () => {
  assert.equal(describeSettings(stateOf([], { loop: true })), "Loop: **on** · Shuffle: **off** · PlayCall: **on**");
  assert.equal(describeSettings(stateOf([], { shuffle: true })), "Loop: **on (because shuffle is on)** · Shuffle: **on** · PlayCall: **on**");
  assert.equal(describeSettings(stateOf([], { loop: true, shuffle: true })), "Loop: **on** · Shuffle: **on** · PlayCall: **on**");
  assert.equal(describeSettings(emptyState()), "Loop: **off** · Shuffle: **off** · PlayCall: **on**");
  assert.equal(describeSettings(stateOf([], { playCall: false })), "Loop: **off** · Shuffle: **off** · PlayCall: **off**");
});

test("the queue listing shows each track's length, the current one, and the total", () => {
  const state = stateOf(["First.mp3", "Second.mp3"]);
  const lengths = { "First.mp3": 125_000, "Second.mp3": 3_600_000 };
  const text = describeQueue(state, { durationOf: (t) => lengths[t.name], playing: true, paused: false });
  assert.match(text, /\*\*Queue\*\* \(2 tracks, 1:02:05\)/);
  assert.match(text, /▶ 1\. First\.mp3 — 2:05/);
  assert.match(text, / {2}2\. Second\.mp3 — 1:00:00/);

  const partial = describeQueue(state, { durationOf: (t) => lengths[t.name === "First.mp3" ? "First.mp3" : "none"], playing: false, paused: false });
  assert.match(partial, /2:05\+\)/); // total is a lower bound while a length is unknown
  assert.match(partial, /2\. Second\.mp3 — length unknown yet/);
  assert.match(partial, /⏭ 1\./);
  assert.match(describeQueue(state, { durationOf: () => 1000, playing: true, paused: true }), /⏸ 1\./);
  assert.equal(describeQueue(emptyState(), { durationOf: () => 1 }), "The queue is empty.");
});

test("a very long queue is truncated in the listing", () => {
  const state = stateOf(Array.from({ length: 40 }, (_, i) => `t${i}`));
  assert.match(describeQueue(state, { durationOf: () => 1000 }), /…and 15 more/);
});

// ---------- persistence (one database, one row per server) ----------
test("state round-trips per server, and a server only gets a row once it's used", () => {
  const guildA = `tg-a-${Date.now()}`;
  const guildB = `tg-b-${Date.now()}`;
  const count = () => voiceDb.prepare(`SELECT COUNT(*) AS n FROM guild_voice_state`).get().n;
  const before = count();

  assert.deepEqual(loadState(guildA), emptyState()); // reading creates nothing
  assert.equal(count(), before);

  saveState(guildA, stateOf(["a", "b"], { shuffle: true }));
  assert.equal(count(), before + 1);
  assert.deepEqual(loadState(guildA), stateOf(["a", "b"], { shuffle: true }));
  assert.deepEqual(loadState(guildB), emptyState());

  saveState(guildA, stateOf(["z"], { loop: true }));
  assert.equal(count(), before + 1); // updated in place
  assert.deepEqual(loadState(guildA), stateOf(["z"], { loop: true }));

  voiceDb.prepare(`DELETE FROM guild_voice_state WHERE guild_id = ?`).run(guildA);
});

test("PlayCall is saved per server, and a server saved before the column existed comes back with it on", () => {
  const stamp = Date.now();
  const [on, off, legacy] = [`pc-on-${stamp}`, `pc-off-${stamp}`, `pc-legacy-${stamp}`];

  saveState(on, stateOf(["a"]));
  saveState(off, stateOf(["a"], { playCall: false }));
  assert.equal(loadState(on).playCall, true);
  assert.equal(loadState(off).playCall, false);
  assert.equal(loadState(`pc-never-${stamp}`).playCall, true);

  // A row written by the older version of the bot (no play_call value at all).
  voiceDb.prepare(`INSERT INTO guild_voice_state (guild_id, queue_json, loop, shuffle, updated_at) VALUES (?, '[]', 0, 0, 'x')`).run(legacy);
  assert.equal(loadState(legacy).playCall, true);

  for (const id of [on, off, legacy]) voiceDb.prepare(`DELETE FROM guild_voice_state WHERE guild_id = ?`).run(id);
});
