import { test } from "node:test";
import assert from "node:assert/strict";
import { matchByName, normalizeName, cleanQuery } from "../src/features/voice-player/match.js";
import { emptyState, currentEntry, enqueue, enqueueFront, insertNext, jumpTo, advance, removeAt, clearQueue, setLoop, setShuffle, setPlayCall, setPersistent, isLooping } from "../src/features/voice-player/queue.js";
import { formatDuration, describeSettings, buildQueuePages, queuePageOf, describeQueueList, describeQueueForModel, QUEUE_PAGE_SIZE } from "../src/features/voice-player/format.js";
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
test("without loop, moving on drops the finished track and anything before it; the cursor stays at 0", () => {
  const next = advance(stateOf(["a", "b", "c"]));
  assert.deepEqual(names(next), ["b", "c"]);
  assert.equal(next.cursor, 0);

  // Tracks left behind the cursor (looping was just turned off) go with the current one.
  assert.deepEqual(names(advance(stateOf(["a", "b", "c"], { cursor: 1 }))), ["c"]);
  assert.deepEqual(names(advance(stateOf(["a"]))), []);
  assert.deepEqual(names(advance(emptyState())), []);
});

test("with loop, moving on only moves the cursor — the list is never reordered", () => {
  let state = stateOf(["a", "b", "c"], { loop: true });
  const seen = [];
  for (let i = 0; i < 4; i++) {
    seen.push(currentEntry(state).name);
    state = advance(state);
    assert.deepEqual(names(state), ["a", "b", "c"]); // always the order they were added
  }
  assert.deepEqual(seen, ["a", "b", "c", "a"]); // wraps around
  assert.equal(advance(stateOf(["a"], { loop: true })).cursor, 0);
});

test("shuffle implies looping, keeps the list in the order added, and just points the cursor at a random OTHER track", () => {
  const shuffled = stateOf(["a", "b", "c", "d"], { shuffle: true, cursor: 1 });
  assert.equal(isLooping(shuffled), true);
  assert.equal(shuffled.loop, false); // the two settings stay separate

  const first = advance(shuffled, () => 0); // candidates are every track except the current one: a, c, d
  assert.equal(first.cursor, 0);
  assert.equal(advance(shuffled, () => 0.5).cursor, 2);
  assert.equal(advance(shuffled, () => 0.99).cursor, 3);
  for (const result of [first, advance(shuffled, () => 0.5), advance(shuffled, () => 0.99)]) {
    assert.deepEqual(names(result), ["a", "b", "c", "d"]); // never reordered
  }
  assert.equal(advance(stateOf(["only"], { shuffle: true })).cursor, 0); // one track: stays on it
});

test("inOrder moves to the next track in list order even while shuffling (used by force play)", () => {
  const shuffled = stateOf(["a", "b", "c"], { shuffle: true, cursor: 2 });
  assert.equal(advance(shuffled, () => 0.5, { inOrder: true }).cursor, 0); // wraps
  assert.equal(advance({ ...shuffled, cursor: 0 }, () => 0.99, { inOrder: true }).cursor, 1);
});

test("jumpTo: looping just moves the cursor; otherwise the tracks before the target count as played and are dropped", () => {
  const looping = jumpTo(stateOf(["a", "b", "c", "d"], { loop: true }), 2);
  assert.deepEqual([names(looping), looping.cursor], [["a", "b", "c", "d"], 2]);

  const plain = jumpTo(stateOf(["a", "b", "c", "d"]), 2);
  assert.deepEqual([names(plain), plain.cursor], [["c", "d"], 0]);
  assert.deepEqual(names(jumpTo(stateOf(["a", "b"]), 0)), ["a", "b"]); // jumping to the current one drops nothing
});

test("the queue can end: nothing is current, advancing does nothing, and a track added then becomes current", () => {
  const ended = stateOf(["a"], { cursor: 1 });
  assert.equal(currentEntry(ended), null);
  assert.equal(advance(ended), ended);
  const added = enqueue(ended, track("b"));
  assert.equal(currentEntry(added).name, "b");
  assert.equal(currentEntry(emptyState()), null);
});

test("removeAt keeps the cursor on the same track, and tracks after a removed current one slide into its place", () => {
  const base = stateOf(["a", "b", "c", "d"], { cursor: 2, loop: true });
  assert.deepEqual([names(removeAt(base, 0)), removeAt(base, 0).cursor], [["b", "c", "d"], 1]); // before: cursor follows "c"
  assert.deepEqual([names(removeAt(base, 3)), removeAt(base, 3).cursor], [["a", "b", "c"], 2]); // after: unchanged
  assert.deepEqual([names(removeAt(base, 2)), removeAt(base, 2).cursor], [["a", "b", "d"], 2]); // the current one: "d" slides in

  const last = stateOf(["a", "b", "c"], { cursor: 2, loop: true });
  assert.equal(removeAt(last, 2).cursor, 0); // looping: wraps to the start
  assert.equal(removeAt({ ...last, loop: false }, 2).cursor, 2); // not looping: the queue has ended
});

test("insertNext, enqueueFront, clearQueue and the setting toggles respect the cursor and never mutate", () => {
  const base = stateOf(["a", "b", "c"], { cursor: 1 });
  assert.deepEqual(names(insertNext(base, track("x"))), ["a", "b", "x", "c"]);
  assert.deepEqual(names(insertNext(emptyState(), track("x"))), ["x"]);
  assert.deepEqual(names(enqueueFront(base, track("x"))), ["a", "x", "b", "c"]); // x takes the cursor's place
  assert.equal(currentEntry(enqueueFront(base, track("x"))).name, "x");
  assert.deepEqual(names(enqueue(base, track("x"))), ["a", "b", "c", "x"]);
  const cleared = clearQueue(base);
  assert.deepEqual([names(cleared), cleared.cursor], [[], 0]);
  assert.equal(setLoop(base, true).loop, true);
  assert.equal(setShuffle(base, true).shuffle, true);
  assert.equal(emptyState().playCall, true); // on by default
  assert.equal(setPlayCall(base, false).playCall, false);
  assert.equal(emptyState().persistent, false); // off by default
  assert.equal(setPersistent(base, true).persistent, true);
  assert.deepEqual(names(base), ["a", "b", "c"]);
  assert.equal(base.cursor, 1);
});

// ---------- formatting ----------
test("durations", () => {
  assert.equal(formatDuration(83_000), "1:23");
  assert.equal(formatDuration(3_723_000), "1:02:03");
  assert.equal(formatDuration(5_000), "0:05");
  assert.equal(formatDuration(undefined), "length unknown yet");
});

test("settings show loop as on-because-of-shuffle while keeping the two separate, plus PlayCall and Persistent", () => {
  assert.equal(describeSettings(stateOf([], { loop: true })), "Loop: **on** · Shuffle: **off** · PlayCall: **on** · Persistent: **off**");
  assert.equal(describeSettings(stateOf([], { shuffle: true })), "Loop: **on (because shuffle is on)** · Shuffle: **on** · PlayCall: **on** · Persistent: **off**");
  assert.equal(describeSettings(stateOf([], { loop: true, shuffle: true })), "Loop: **on** · Shuffle: **on** · PlayCall: **on** · Persistent: **off**");
  assert.equal(describeSettings(emptyState()), "Loop: **off** · Shuffle: **off** · PlayCall: **on** · Persistent: **off**");
  assert.equal(describeSettings(stateOf([], { playCall: false, persistent: true })), "Loop: **off** · Shuffle: **off** · PlayCall: **off** · Persistent: **on**");
});

// 20 tracks of 4:03.65 each = exactly 1:21:13 in total.
const twenty = (extra = {}) => stateOf(Array.from({ length: 20 }, (_, i) => `Song${i + 1}.mp4`), extra);
const view = { durationOf: () => 243_650, playing: true, paused: false };

test("the queue view: title with total, previous + current + next two, All queue (6 per page), settings", () => {
  const pages = buildQueuePages(twenty({ cursor: 3 }), view); // the 4th track is current
  assert.equal(pages.length, Math.ceil(20 / QUEUE_PAGE_SIZE)); // 4 pages
  assert.equal(pages[0].title, "Queue (20 tracks, 1:21:13)");
  assert.equal(pages[0].description, [
    "ᛝ 3. Song3.mp4 — 4:04",
    "▶ 4. Song4.mp4 — 4:04",
    "ᛝ 5. Song5.mp4 — 4:04",
    "ᛝ 6. Song6.mp4 — 4:04",
    "-".repeat(36),
    "**All queue:**",
    "1. Song1.mp4 — 4:04",
    "2. Song2.mp4 — 4:04",
    "3. Song3.mp4 — 4:04",
    "▶ 4. Song4.mp4 — 4:04", // the current track is marked here too
    "5. Song5.mp4 — 4:04",
    "6. Song6.mp4 — 4:04",
    "",
    "Loop: **off** · Shuffle: **off** · PlayCall: **on** · Persistent: **off**",
  ].join("\n"));
  assert.deepEqual(pages.map((p) => p.footer), ["Page 1 / 4", "Page 2 / 4", "Page 3 / 4", "Page 4 / 4"]);
});

test("only the 'All queue' part changes between pages; the top part and the settings line are on every page", () => {
  const pages = buildQueuePages(twenty({ cursor: 3, loop: true }), view);
  const top = (page) => page.description.split("-".repeat(36))[0];
  const settings = (page) => page.description.split("\n").at(-1);
  for (const page of pages) {
    assert.equal(top(page), top(pages[0]));
    assert.equal(settings(page), "Loop: **on** · Shuffle: **off** · PlayCall: **on** · Persistent: **off**");
  }
  const allQueue = (page) => page.description.split("**All queue:**\n")[1].split("\n\n")[0];
  assert.match(allQueue(pages[1]), /^7\. Song7\.mp4/);
  assert.match(allQueue(pages[3]), /19\. Song19\.mp4 — 4:04\n20\. Song20\.mp4 — 4:04$/); // last page: 2 tracks
  assert.equal(allQueue(pages[1]).includes("▶"), false); // the current track isn't on this page
});

test("the queue opens on the page that holds the current track", () => {
  assert.equal(queuePageOf(0), 0);
  assert.equal(queuePageOf(5), 0);
  assert.equal(queuePageOf(6), 1);
  assert.equal(queuePageOf(13), 2);
  assert.equal(queuePageOf(19), 3);
});

test("at the ends there's no previous / next line; pause and 'not in a call' change the marker", () => {
  const first = buildQueuePages(twenty({ cursor: 0 }), view)[0].description.split("\n");
  assert.deepEqual(first.slice(0, 3), ["▶ 1. Song1.mp4 — 4:04", "ᛝ 2. Song2.mp4 — 4:04", "ᛝ 3. Song3.mp4 — 4:04"]);

  const last = buildQueuePages(twenty({ cursor: 19 }), view)[3].description.split("\n");
  assert.deepEqual(last.slice(0, 2), ["ᛝ 19. Song19.mp4 — 4:04", "▶ 20. Song20.mp4 — 4:04"]);
  assert.equal(last[2], "-".repeat(36));

  assert.match(buildQueuePages(twenty(), { ...view, paused: true })[0].description, /^⏸ 1\./);
  assert.match(buildQueuePages(twenty(), { ...view, playing: false })[0].description, /^⏭ 1\./);
});

test("unknown lengths show as '+' in the total; an ended queue says so; shuffle explains the next track; empty queue", () => {
  const some = (entry) => (entry.name === "Song1.mp4" ? 60_000 : undefined);
  const partial = buildQueuePages(twenty(), { ...view, durationOf: some })[0];
  assert.equal(partial.title, "Queue (20 tracks, 1:00+)");
  assert.match(partial.description, /2\. Song2\.mp4 — length unknown yet/);

  const ended = buildQueuePages(twenty({ cursor: 20 }), view)[3].description;
  assert.match(ended, /^Nothing is playing — the queue has ended/);
  assert.equal(ended.includes("▶"), false);

  assert.match(buildQueuePages(twenty({ shuffle: true }), view)[0].description, /\(Shuffle is on: the next track is picked at random\.\)/);

  const [empty] = buildQueuePages(emptyState(), view);
  assert.equal(empty.title, "Queue (empty)");
  assert.match(empty.description, /^Nothing is queued\./);
  assert.equal(buildQueuePages(stateOf(["x.mp3"]), view)[0].title, "Queue (1 track, 4:04)");
  assert.equal(buildQueuePages(stateOf(["x.mp3", "y.mp3"]), { ...view, durationOf: () => undefined })[0].title, "Queue (2 tracks, length unknown yet)"); // nothing converted yet
});

test("long names are cut in the queue view", () => {
  const long = "A very long song title that goes on and on for far too long.mp3";
  const [page] = buildQueuePages(stateOf([long]), view);
  const line = page.description.split("\n")[0];
  assert.ok(line.includes("…"));
  assert.ok(!line.includes("far too long"));
});

test("queue list: the static order, ▶ only on the current track, settings at the end", () => {
  const text = describeQueueList(stateOf(["A.mp3", "B.mp3", "C.mp3"], { cursor: 1, loop: true }), { durationOf: () => 60_000, playing: true, paused: false });
  assert.equal(text, ["**Queue** (3 tracks, 3:00)", "  1. A.mp3 — 1:00", "▶ 2. B.mp3 — 1:00", "  3. C.mp3 — 1:00", "Loop: **on** · Shuffle: **off** · PlayCall: **on** · Persistent: **off**"].join("\n"));
  assert.equal(describeQueueList(emptyState(), view), "The queue is empty.");
});

test("a long queue list shows the stretch around the current track, with counts for what's left out", () => {
  const sixty = stateOf(Array.from({ length: 60 }, (_, i) => `S${i + 1}.mp3`), { cursor: 40 });
  const text = describeQueueList(sixty, view);
  const shown = text.split("\n").filter((line) => /^[ ▶⏸⏭] \d+\./.test(line));

  assert.equal(shown.length, 25);
  assert.match(text, /^\*\*Queue\*\* \(60 tracks/);
  assert.match(text, /…35 earlier/); // tracks 1-35 are not shown
  assert.match(text, /▶ 41\. S41\.mp3/); // the current track is
  assert.equal(text.includes("more"), false); // the window runs to the end of the queue, so nothing is left out after it
  assert.equal(shown[0], "  36. S36.mp3 — 4:04");
  assert.equal(shown.at(-1), "  60. S60.mp3 — 4:04");

  const early = describeQueueList({ ...sixty, cursor: 2 }, view);
  assert.equal(early.includes("earlier"), false);
  assert.match(early, /…and 35 more/);
});

test("the complete queue for .aii has full names in order and marks the current one", () => {
  const long = "A very long song title that goes on and on for far too long.mp3";
  assert.equal(describeQueueForModel(stateOf(["a.mp3", long], { cursor: 1 })), `2 tracks in the queue (in the order they were added):\n1. a.mp3\n2. ${long}  <- current`);
  assert.equal(describeQueueForModel(emptyState()), "The queue is empty.");
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

test("Persistent is saved per server and defaults to off, including for servers saved before it existed", () => {
  const stamp = Date.now();
  const [on, legacy] = [`ps-on-${stamp}`, `ps-legacy-${stamp}`];

  saveState(on, stateOf(["a"], { persistent: true }));
  assert.equal(loadState(on).persistent, true);
  assert.equal(loadState(`ps-never-${stamp}`).persistent, false);

  voiceDb.prepare(`INSERT INTO guild_voice_state (guild_id, queue_json, loop, shuffle, updated_at) VALUES (?, '[]', 0, 0, 'x')`).run(legacy);
  assert.equal(loadState(legacy).persistent, false);

  for (const id of [on, legacy]) voiceDb.prepare(`DELETE FROM guild_voice_state WHERE guild_id = ?`).run(id);
});

test("the cursor lives in its own table: moving it never rewrites the queue, and an unchanged save writes nothing", () => {
  const guild = `cur-${Date.now()}`;
  const logCount = (table) => voiceDb.prepare(`SELECT COUNT(*) AS n FROM change_log WHERE tbl = ?`).get(table).n;
  const state = stateOf(["a", "b", "c", "d"], { loop: true });

  saveState(guild, state);
  const [queueEntries, cursorEntries] = [logCount("guild_voice_state"), logCount("guild_voice_cursor")];

  saveState(guild, state); // exactly the same state again
  assert.equal(logCount("guild_voice_state"), queueEntries);
  assert.equal(logCount("guild_voice_cursor"), cursorEntries);

  saveState(guild, { ...state, cursor: 2 }); // a track change
  saveState(guild, { ...state, cursor: 3 });
  assert.equal(logCount("guild_voice_state"), queueEntries); // the queue row wasn't touched
  assert.equal(logCount("guild_voice_cursor"), cursorEntries + 2); // two tiny cursor entries
  assert.equal(loadState(guild).cursor, 3);
  assert.deepEqual(names(loadState(guild)), ["a", "b", "c", "d"]);

  const logged = voiceDb.prepare(`SELECT row FROM change_log WHERE tbl = 'guild_voice_cursor' ORDER BY id DESC LIMIT 1`).get().row;
  assert.ok(logged.length < 80, `a cursor log entry should be tiny, was ${logged.length} bytes`);

  saveState(guild, { ...state, queue: state.queue.slice(0, 2), cursor: 1 }); // a real queue change
  assert.equal(logCount("guild_voice_state"), queueEntries + 1);

  voiceDb.prepare(`DELETE FROM guild_voice_state WHERE guild_id = ?`).run(guild);
  voiceDb.prepare(`DELETE FROM guild_voice_cursor WHERE guild_id = ?`).run(guild);
});

test("a server saved before the cursor existed resumes at its first track; a stale cursor never points past the end", () => {
  const [legacy, shrunk] = [`cur-legacy-${Date.now()}`, `cur-shrunk-${Date.now()}`];
  voiceDb.prepare(`INSERT INTO guild_voice_state (guild_id, queue_json, loop, shuffle, updated_at) VALUES (?, ?, 0, 0, 'x')`).run(legacy, JSON.stringify([track("old1"), track("old2")]));
  assert.equal(loadState(legacy).cursor, 0);
  assert.equal(currentEntry(loadState(legacy)).name, "old1");

  saveState(shrunk, stateOf(["a", "b", "c"], { cursor: 2 }));
  voiceDb.prepare(`UPDATE guild_voice_state SET queue_json = ? WHERE guild_id = ?`).run(JSON.stringify([track("a")]), shrunk); // e.g. a backup restore of just one table
  assert.equal(loadState(shrunk).cursor, 1); // clamped to "ended"

  for (const id of [legacy, shrunk]) {
    voiceDb.prepare(`DELETE FROM guild_voice_state WHERE guild_id = ?`).run(id);
    voiceDb.prepare(`DELETE FROM guild_voice_cursor WHERE guild_id = ?`).run(id);
  }
});
