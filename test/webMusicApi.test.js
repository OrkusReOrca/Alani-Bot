import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

process.env.DISCORD_OWNER_0 = "900000000000000001";
const OWNER = "900000000000000001";
const ADA = "100000000000000001";
const BOB = "100000000000000002";
const STRANGER = "100000000000000009";
const GUILD = "500000000000000001";
const VC = "600000000000000001";
const OTHER_VC = "600000000000000002";
const ACCOUNT = "a".repeat(32);

const { createWebMusicApi } = await import("../src/features/voice-player/webApi.js");
const { makeSession, memoryStore } = await import("./helpers/voiceFakes.js");
const { emptyState } = await import("../src/features/voice-player/queue.js");

const FILES = ["A.mp3", "B.mp3", "C.mp3", "D.mp3"].map((name, i) => ({ id: `f${i}`, name, mimeType: "audio/mpeg", size: "1000", modifiedTime: `2026-10-0${i + 1}T00:00:00Z` }));

function world() {
  const store = memoryStore();
  const session = makeSession({ store, guildId: GUILD });
  const voice = new Map([[ADA, { channelId: VC }]]); // Ada is in the voice channel, Bob is not
  const guild = {
    id: GUILD,
    name: "Test server",
    iconURL: () => null,
    members: { fetch: async (id) => ([ADA, BOB, OWNER].includes(id) ? { id } : Promise.reject(new Error("Unknown Member"))) },
    voiceStates: { cache: voice },
    channels: { cache: new Map([[VC, { name: "music" }], [OTHER_VC, { name: "chat" }]]) },
  };
  const used = new Map();
  const plays = new Map();
  const playbacks = new Map();
  const time = { now: 1_000_000 };
  const audioDir = fs.mkdtempSync(path.join(os.tmpdir(), "webmusic-"));
  const cache = {
    pinned: {},
    ensured: [], // [name, urgent] in the order conversions were asked for
    lengths: { "A.mp3": 61_000 }, // song lengths once converted
    converting: new Map(), // file name -> its job, for songs still being converted
    convert(name) {
      const job = Object.assign(new EventEmitter(), { status: "running", waitForChange: () => new Promise((resolve) => job.once("change", resolve)) });
      this.converting.set(name, job);
      return () => (this.converting.delete(name), (job.status = "done"), job.emit("change"));
    },
    ensure(entry, { urgent = false } = {}) {
      this.ensured.push([entry.name, urgent]);
      const converting = this.converting.get(entry.name);
      if (converting) return converting;
      const job = Object.assign(new EventEmitter(), { status: "done", waitForChange: () => new Promise(() => {}) });
      fs.writeFileSync(path.join(audioDir, entry.key), Buffer.from("0123456789"));
      return job;
    },
    open: () => ({ stream: Readable.from([Buffer.from("01234")]) }), // a song streamed while it converts
    finishedFile(entry) {
      return this.converting.has(entry.name) ? null : { path: path.join(audioDir, entry.key), bytes: 10 };
    },
    durationOf(entry) {
      return this.converting.has(entry.name) ? undefined : this.lengths[entry.name];
    },
    setPinned(keys, owner) {
      this.pinned[owner] = keys;
    },
  };
  const handle = createWebMusicApi({
    discord: () => ({ guilds: { cache: new Map([[GUILD, guild]]) } }),
    getSession: () => session.session,
    prepareVoice: async () => {},
    audioCache: () => cache,
    listPlayableFiles: async () => FILES,
    clock: () => time.now,
    random: () => 0, // shuffle always draws the first song it may
    waitMs: 300,
    waitForConversionMs: 50,
    store: {
      loadPlayback: (id) => playbacks.get(id) ?? { playing: false, positionMs: 0, updatedAt: 0, rev: 0, waiting: false, playId: 0 },
      savePlayback: (id, pb) => playbacks.set(id, pb),
      loadState: store.loadState,
      saveState: store.saveState,
      stationOf: (account) => `account:${account}`,
      isStationMember: (station, account) => station === `account:${account}`,
      guildsUsedBy: (user) => new Map([...used].filter(([key]) => key.endsWith(`|${user}`)).map(([key, at]) => [key.split("|")[0], at])),
      noteGuildUser: (g, u) => used.set(`${g}|${u}`, new Date().toISOString()),
      playHistory: () => plays,
      recordPlay: (id) => plays.set(id, { plays: (plays.get(id)?.plays ?? 0) + 1, lastPlayedAt: "2026-10-16T00:00:00.000Z" }),
    },
  });
  return { handle, session, store, voice, used, plays, cache, time };
}

async function serve(handle) {
  const server = http.createServer(handle);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/web/music`;
  return {
    get: async (p, headers = {}) => {
      const res = await fetch(`${base}${p}`, { headers });
      const type = res.headers.get("content-type") ?? "";
      return { status: res.status, headers: res.headers, json: type.includes("json") ? await res.json() : null, text: type.includes("json") ? null : await res.text() };
    },
    post: async (p, body) => {
      const res = await fetch(`${base}${p}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return { status: res.status, json: await res.json() };
    },
  };
}

test("library lists every file with play counts; servers are only the ones you share and used lately", async () => {
  const w = world();
  const api = await serve(w.handle);
  const library = (await api.get("/library")).json.files;
  assert.deepEqual(library.map((f) => [f.name, f.type, f.plays]), [["A.mp3", "public", 0], ["B.mp3", "public", 0], ["C.mp3", "public", 0], ["D.mp3", "public", 0]]);

  assert.deepEqual((await api.get(`/servers?discordUserId=${ADA}`)).json.servers, []); // never used there, bot not in a call
  w.used.set(`${GUILD}|${ADA}`, new Date().toISOString());
  assert.deepEqual((await api.get(`/servers?discordUserId=${ADA}`)).json.servers.map((s) => s.name), ["Test server"]);
  w.used.set(`${GUILD}|${STRANGER}`, new Date().toISOString());
  assert.deepEqual((await api.get(`/servers?discordUserId=${STRANGER}`)).json.servers, []); // not a member
  assert.deepEqual((await api.get("/servers")).json.servers, []); // no Discord linked
  assert.equal((await api.get(`/server/${GUILD}?discordUserId=${STRANGER}`)).status, 404);
  assert.equal((await api.get(`/server/${GUILD}`)).status, 403);
});

test("a server's player: add joins your call, controls need you in the call, the view shows it all", async () => {
  const w = world();
  const api = await serve(w.handle);
  const act = (user, body) => api.post(`/server/${GUILD}/action`, { discordUserId: user, ...body });

  const bobAdd = await act(BOB, { action: "add", fileIds: ["f0"] });
  assert.equal(bobAdd.status, 409);
  assert.match(bobAdd.json.error, /Join a voice channel first/);

  const added = await act(ADA, { action: "add", fileIds: ["f0", "f1", "f2"] });
  assert.equal(added.status, 200);
  const view = added.json.player;
  assert.deepEqual([view.connected, view.channel.name, view.you.inCall, view.can.control, view.playing, view.cursor], [true, "music", true, true, true, 0]);
  assert.deepEqual(view.queue.map((q) => [q.name, q.durationMs]), [["A.mp3", 61000], ["B.mp3", null], ["C.mp3", null]]);
  assert.equal(typeof view.positionMs, "number");

  assert.deepEqual((await act(ADA, { action: "add", fileIds: ["f3"], where: "next" })).json.player.queue.map((q) => q.name), ["A.mp3", "D.mp3", "B.mp3", "C.mp3"]);
  assert.deepEqual((await act(ADA, { action: "move", from: 3, to: 1 })).json.player.queue.map((q) => q.name), ["A.mp3", "C.mp3", "D.mp3", "B.mp3"]);
  const skipped = (await act(ADA, { action: "markSkip", index: 1, on: true })).json.player;
  assert.deepEqual(skipped.queue.map((q) => q.skip), [false, true, false, false]);
  assert.equal((await act(ADA, { action: "next" })).json.player.queue[0].name, "D.mp3"); // C was passed over (and played tracks drop off)

  const bobTries = await act(BOB, { action: "pause" });
  assert.equal(bobTries.status, 409);
  assert.match(bobTries.json.error, /You need to be in my voice channel \(#music\)/); // channel names, not Discord mentions
  assert.equal((await act(ADA, { action: "pause" })).json.player.paused, true);
  assert.equal((await act(ADA, { action: "loop", on: true })).json.player.loop, true);
  assert.equal((await act(ADA, { action: "persistent", on: true })).status, 409); // owners only
  assert.equal((await act(ADA, { action: "removeAll" })).status, 409); // SongMaster only
  assert.equal((await act(ADA, { action: "jump", index: 9 })).status, 409);
  assert.equal((await act(ADA, { action: "nonsense" })).status, 400);
  assert.ok(w.used.has(`${GUILD}|${ADA}`)); // using it from the web counts as using the server
});

// A device that plays the station ("listening") or only looks at it.
const station = (api) => ({
  act: (body) => api.post(`/station/${ACCOUNT}/action`, body),
  look: async (query = "listening=1") => (await api.get(`/station/${ACCOUNT}?${query}`)).json,
});

test("a station: add, reorder, mark skip, next/previous, played counts, pinned in the cache", async () => {
  const w = world();
  const api = await serve(w.handle);
  const { act, look } = station(api);
  const empty = await look();
  assert.deepEqual([empty.kind, empty.station, empty.cursor, empty.queue, empty.playback.playing], ["station", `account:${ACCOUNT}`, null, [], false]);

  await act({ action: "add", fileIds: ["f0", "f1", "f2"] });
  let player = (await act({ action: "loop", on: true })).json.player;
  assert.deepEqual([player.cursor, player.queue.length, player.loop, player.playback.playing, player.playback.playId], [0, 3, true, true, 1]); // adding to an empty station starts it
  assert.deepEqual(w.cache.pinned[`account:${ACCOUNT}`].length, 3);
  assert.equal(w.plays.get("f0").plays, 1);
  await act({ action: "markSkip", index: 1, on: true });
  assert.equal((await act({ action: "next" })).json.player.cursor, 2); // B is marked skip
  assert.equal((await act({ action: "previous" })).json.player.cursor, 0);
  assert.deepEqual((await act({ action: "move", from: 0, to: 2 })).json.player.queue.map((q) => q.name), ["B.mp3", "C.mp3", "A.mp3"]);
  assert.equal((await act({ action: "remove", index: 7 })).status, 409);
  const before = (await look()).playback.playId;
  assert.equal((await act({ action: "ended", playId: before })).json.player.playback.playId, before); // not from the lead device: ignored
  assert.deepEqual((await act({ action: "removeAll" })).json.player.queue, []);
  assert.equal((await api.get("/station/not-an-account")).status, 404);
  assert.equal((await api.get(`/station/${ACCOUNT}?station=account:${"b".repeat(32)}`)).status, 404); // someone else's station
  assert.deepEqual(w.store.loadState(GUILD), emptyState()); // a server's queue is untouched
});

test("the station runs its own clock: songs follow each other on time, pause / seek / play change it for everyone", async () => {
  const w = world();
  const api = await serve(w.handle);
  const { act, look } = station(api);
  Object.assign(w.cache.lengths, { "B.mp3": 30_000, "C.mp3": 45_000 });

  await act({ action: "add", fileIds: ["f0", "f1", "f2"] });
  await look(); // a device tunes in
  w.time.now += 20_000;
  let pb = (await look()).playback;
  assert.deepEqual([pb.playing, pb.positionMs, pb.playId], [true, 20_000, 1]);
  w.time.now += 50_000; // A (61 s) ended 9 s ago: B started then
  let view = await look();
  assert.deepEqual([view.queue.map((q) => q.fileId), view.playback.positionMs, view.playback.playId], [["f1", "f2"], 9_000, 2]);
  assert.equal(w.plays.get("f1").plays, 1); // counted when it started
  w.time.now += 21_000 + 45_000 + 1_000; // B ends, C plays through, the queue has ended
  view = await look();
  assert.deepEqual([view.cursor, view.playback.playing], [null, false]);

  await act({ action: "add", fileIds: ["f1"] });
  await act({ action: "loop", on: true });
  w.time.now += 31_000; // one song on loop: it starts again (a new play)
  pb = (await look()).playback;
  assert.deepEqual([pb.positionMs, pb.playId > 3], [1_000, true]);
  pb = (await act({ action: "pause", positionMs: 2_000 })).json.player.playback;
  w.time.now += 600_000;
  assert.deepEqual([(await look()).playback.playing, (await look()).playback.positionMs], [false, 2_000]); // paused for everyone
  pb = (await act({ action: "seek", positionMs: 10_000 })).json.player.playback;
  pb = (await act({ action: "play" })).json.player.playback;
  w.time.now += 5_000;
  assert.deepEqual([(await look()).playback.playing, (await look()).playback.positionMs], [true, 15_000]);
});

test("one device listening leads: the station waits for its song end (30 s at most); with two, the clock decides", async () => {
  const w = world();
  const api = await serve(w.handle);
  const { act, look } = station(api);
  const PHONE = "phone-device-1";
  const LAPTOP = "laptop-device-1";
  Object.assign(w.cache.lengths, { "B.mp3": 30_000 });
  await act({ action: "add", fileIds: ["f0", "f1"] });
  const start = await look(`listening=1&device=${PHONE}`);
  assert.equal(start.playback.actionRev, start.playback.rev); // adding was a control

  w.time.now += 61_000 + 10_000; // A ended on the clock 10 s ago, but the phone is still playing it
  let view = await look(`listening=1&device=${PHONE}`);
  assert.deepEqual([view.cursor, view.playback.playId], [0, 1]);
  await act({ action: "ended", playId: 1, device: LAPTOP }); // not the lead device
  assert.equal((await act({ action: "ended", playId: 1, device: PHONE })).json.player.playback.positionMs, 0); // B starts now
  view = await look(`listening=1&device=${PHONE}`);
  assert.deepEqual([view.queue[view.cursor].fileId, view.playback.playId, view.playback.actionRev], ["f1", 2, start.playback.actionRev]); // the clock's own change
  assert.equal((await act({ action: "ended", playId: 1, device: PHONE })).json.player.playback.playId, 2); // late repeat: ignored

  w.time.now += 30_000 + 29_000; // the phone keeps listening but never says B ended
  assert.equal((await look(`listening=1&device=${PHONE}`)).playback.playId, 2);
  w.time.now += 2_000; // 31 s after B's end the clock moves on by itself
  view = await look(`listening=1&device=${PHONE}`);
  assert.deepEqual([view.cursor, view.playback.playing], [null, false]);

  // two devices: the clock decides at once
  await act({ action: "add", fileIds: ["f1", "f0"] });
  w.time.now += 28_000;
  await look(`listening=1&device=${PHONE}`);
  await look(`listening=1&device=${LAPTOP}`);
  w.time.now += 3_000;
  view = await look(`listening=1&device=${LAPTOP}`);
  assert.deepEqual([view.queue[view.cursor].fileId, view.playback.positionMs], ["f0", 1_000]);
});

test("nobody listening: after 40 s without a listening device the station pauses where it was", async () => {
  const w = world();
  const api = await serve(w.handle);
  const { act, look } = station(api);
  await act({ action: "add", fileIds: ["f0"] });
  await look(); // tuned in
  w.time.now += 10_000;
  await look("listening=0"); // a device that only shows it doesn't keep it going
  w.time.now += 50_000;
  const pb = (await look("listening=0")).playback;
  assert.deepEqual([pb.playing, pb.positionMs], [false, 40_000]); // stopped 40 s after the last listener
  assert.equal((await act({ action: "play" })).json.player.playback.playing, true);
});

test("a song still being converted: the station waits at its start until it is ready, or until it streams early", async () => {
  const w = world();
  const api = await serve(w.handle);
  const { act, look } = station(api);
  const finishB = w.cache.convert("B.mp3");
  w.cache.convert("C.mp3"); // a long one: never finishes in this test
  w.cache.lengths["B.mp3"] = 30_000;

  await act({ action: "add", fileIds: ["f0", "f1", "f2"] });
  await act({ action: "next" }); // B: still converting
  w.time.now += 8_000;
  let pb = (await look()).playback;
  assert.deepEqual([pb.playing, pb.waiting, pb.positionMs], [true, true, 0]);
  finishB();
  w.time.now += 3_000;
  pb = (await look()).playback;
  assert.deepEqual([pb.waiting, pb.positionMs], [false, 3_000]); // runs from when it was ready

  await act({ action: "next" }); // C: still converting
  w.time.now += 5_000;
  assert.deepEqual([(await look()).playback.waiting, (await look()).playback.positionMs], [true, 0]);
  const early = await api.get("/stream/f2"); // gave up waiting: streams while it converts
  assert.equal(early.status, 200);
  w.time.now += 2_000;
  pb = (await look()).playback;
  assert.deepEqual([pb.waiting, pb.positionMs], [false, 2_000]); // runs from when it started streaming
});

test("a station converts its songs ahead: the current one first, then the next, then in playing order", async () => {
  const w = world();
  const api = await serve(w.handle);
  const { act } = station(api);
  await act({ action: "add", fileIds: ["f0", "f1", "f2", "f3"] });
  await act({ action: "loop", on: true });
  await act({ action: "markSkip", index: 3, on: true });
  w.cache.ensured.length = 0;
  await act({ action: "jump", index: 2 });
  assert.deepEqual(w.cache.ensured.slice(-3), [["C.mp3", true], ["A.mp3", false], ["B.mp3", false]]); // D is marked skip
});

test("waiting for a change: the answer comes the moment another device changes something, or after the wait", async () => {
  const w = world();
  const api = await serve(w.handle);
  const { act } = station(api);
  await act({ action: "add", fileIds: ["f0", "f1"] });
  const first = await api.get(`/station/${ACCOUNT}?listening=1`);
  assert.match(first.headers.get("server-timing"), /^bot;desc="Alani bot";dur=\d+(\.\d+)?$/);
  const { version } = first.json;

  const waiting = api.get(`/station/${ACCOUNT}?listening=1&after=${version}`);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await act({ action: "pause", positionMs: 1000 });
  const woken = (await waiting).json;
  assert.notEqual(woken.version, version);
  assert.equal(woken.playback.playing, false);

  const started = Date.now();
  const quiet = (await api.get(`/station/${ACCOUNT}?listening=1&after=${woken.version}`)).json;
  assert.ok(Date.now() - started >= 250); // nothing changed: it answers after the wait
  assert.equal(quiet.version, woken.version);
  assert.equal((await api.get(`/station/${ACCOUNT}?after=old.0`)).json.version, woken.version); // an old version: at once
});

test("a resent action is applied once; an index is checked against the song the device meant; replace", async () => {
  const w = world();
  const api = await serve(w.handle);
  const { act } = station(api);
  await act({ action: "add", fileIds: ["f0", "f1", "f2"] });
  await act({ action: "loop", on: true });
  assert.equal((await act({ action: "next", actionId: "a1" })).json.player.cursor, 1);
  assert.equal((await act({ action: "next", actionId: "a1" })).json.player.cursor, 1); // the same action again: not twice

  await act({ action: "move", from: 2, to: 0, fileId: "f2" }); // C A B, B (current) at 2
  const removed = (await act({ action: "remove", index: 2, fileId: "f0" })).json.player; // index 2 is B now; A is at 1
  assert.deepEqual(removed.queue.map((q) => q.fileId), ["f2", "f1"]);
  assert.equal((await act({ action: "remove", index: 0, fileId: "f9" })).status, 409); // gone: nothing happens

  const replaced = (await act({ action: "replace", fileIds: ["f3", "f0"] })).json.player;
  assert.deepEqual([replaced.queue.map((q) => q.fileId), replaced.cursor, replaced.playback.playing], [["f3", "f0"], 0, true]);
});

test("shuffle draws the next song ahead: the view says which, and next plays exactly that one", async () => {
  const w = world();
  const api = await serve(w.handle);
  const { act } = station(api);
  await act({ action: "add", fileIds: ["f0", "f1", "f2", "f3"] });
  assert.equal((await act({ action: "loop", on: true })).json.player.nextIndex, 1); // in order
  const shuffled = (await act({ action: "shuffle", on: true })).json.player;
  assert.equal(shuffled.nextIndex, 1); // drawn (random() = 0: the first other song)
  const moved = (await act({ action: "next" })).json.player;
  assert.equal(moved.cursor, 1);
  assert.equal(moved.nextIndex, 0); // the next one is drawn at once
});

test("streaming: the whole file, or a byte range for seeking", async () => {
  const w = world();
  const api = await serve(w.handle);
  const whole = await api.get("/stream/f0");
  assert.deepEqual([whole.status, whole.headers.get("content-type"), whole.headers.get("accept-ranges"), whole.text], [200, "audio/ogg", "bytes", "0123456789"]);
  const part = await api.get("/stream/f0", { Range: "bytes=2-5" });
  assert.deepEqual([part.status, part.headers.get("content-range"), part.text], [206, "bytes 2-5/10", "2345"]);
  assert.equal((await api.get("/stream/f0", { Range: "bytes=50-" })).status, 416);
  assert.equal((await api.get("/stream/missing")).status, 404);
});
