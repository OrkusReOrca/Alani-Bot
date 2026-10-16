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
    converting: new Map(), // file name -> its job, for songs still being converted
    convert(name) {
      const job = Object.assign(new EventEmitter(), { status: "running", waitForChange: () => new Promise((resolve) => job.once("change", resolve)) });
      this.converting.set(name, job);
      return () => (this.converting.delete(name), (job.status = "done"), job.emit("change"));
    },
    ensure(entry) {
      const converting = this.converting.get(entry.name);
      if (converting) return converting;
      const job = Object.assign(new EventEmitter(), { status: "done", waitForChange: () => new Promise(() => {}) });
      fs.writeFileSync(path.join(audioDir, entry.key), Buffer.from("0123456789"));
      return job;
    },
    open: () => ({ stream: Readable.from([Buffer.from("01234")]) }),
    finishedFile(entry) {
      return this.converting.has(entry.name) ? null : { path: path.join(audioDir, entry.key), bytes: 10 };
    },
    durationOf: (entry) => (entry.name === "A.mp3" ? 61_000 : undefined),
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
    waitForConversionMs: 50,
    store: {
      loadPlayback: (id) => playbacks.get(id) ?? { playing: false, positionMs: 0, updatedAt: 0, rev: 0 },
      savePlayback: (id, pb) => playbacks.set(id, pb),
      loadState: store.loadState,
      saveState: store.saveState,
      personalQueueId: (id) => `account:${id}`,
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

test("a personal queue: add, reorder, mark skip, next/previous, played counts, pinned in the cache", async () => {
  const w = world();
  const api = await serve(w.handle);
  const act = (body) => api.post(`/personal/${ACCOUNT}/action`, body);
  const empty = (await api.get(`/personal/${ACCOUNT}`)).json;
  assert.deepEqual([empty.kind, empty.cursor, empty.queue, empty.playback.playing], ["personal", null, [], false]);

  await act({ action: "add", fileIds: ["f0", "f1", "f2"] });
  let player = (await act({ action: "loop", on: true })).json.player;
  assert.deepEqual([player.cursor, player.queue.length, player.loop, player.playback.playing], [0, 3, true, true]); // adding to an empty queue starts it
  assert.deepEqual(w.cache.pinned[`account:${ACCOUNT}`].length, 3);
  assert.equal(w.plays.get("f0").plays, 1);
  await act({ action: "markSkip", index: 1, on: true });
  assert.equal((await act({ action: "next" })).json.player.cursor, 2); // B is marked skip
  assert.equal((await act({ action: "previous" })).json.player.cursor, 0);
  assert.deepEqual((await act({ action: "move", from: 0, to: 2 })).json.player.queue.map((q) => q.name), ["B.mp3", "C.mp3", "A.mp3"]);
  assert.equal((await act({ action: "remove", index: 7 })).status, 409);
  assert.deepEqual((await act({ action: "removeAll" })).json.player.queue, []);
  assert.equal((await api.get("/personal/not-an-account")).status, 404);
  assert.deepEqual(w.store.loadState(GUILD), emptyState()); // a server's queue is untouched
});

test("a personal queue is in step on every device: play, pause, seek, and a song that ends moves on once", async () => {
  const w = world();
  const api = await serve(w.handle);
  const act = (body) => api.post(`/personal/${ACCOUNT}/action`, body);
  const look = async () => (await api.get(`/personal/${ACCOUNT}`)).json;

  await act({ action: "add", fileIds: ["f0", "f1"] });
  w.time.now += 5000;
  let pb = (await look()).playback;
  assert.deepEqual([pb.playing, pb.positionMs], [true, 5000]); // the position moves on with the clock

  pb = (await act({ action: "pause", positionMs: 5200 })).json.player.playback;
  w.time.now += 60_000;
  assert.deepEqual([(await look()).playback.playing, (await look()).playback.positionMs], [false, 5200]); // paused for everyone
  pb = (await act({ action: "seek", positionMs: 30_000 })).json.player.playback;
  assert.equal(pb.positionMs, 30_000);
  pb = (await act({ action: "play" })).json.player.playback;
  assert.equal(pb.playing, true);

  // both devices reach the end of the song and report it with the revision they saw: it moves on once
  const seen = pb.rev;
  assert.equal((await act({ action: "ended", rev: seen })).json.player.cursor, 0);
  const second = (await act({ action: "ended", rev: seen })).json.player;
  assert.deepEqual([second.queue.map((q) => q.fileId), second.playback.positionMs], [["f1"], 0]);

  // one song on loop plays again from the start
  await act({ action: "loop", on: true });
  const again = (await look()).playback;
  w.time.now += 30_000;
  const looped = (await act({ action: "ended", rev: again.rev })).json.player;
  assert.deepEqual([looped.queue.map((q) => q.fileId), looped.cursor, looped.playback.positionMs, looped.playback.playing], [["f1"], 0, 0, true]);
  assert.ok(looped.playback.rev > again.rev); // devices see a new revision, so they start it again

  assert.equal((await act({ action: "removeAll" })).json.player.playback.playing, false);
});

test("a song still being converted: its clock stands still until it is ready, or until it streams early", async () => {
  const w = world();
  const api = await serve(w.handle);
  const act = (body) => api.post(`/personal/${ACCOUNT}/action`, body);
  const look = async () => (await api.get(`/personal/${ACCOUNT}`)).json.playback;
  const finishB = w.cache.convert("B.mp3");
  w.cache.convert("C.mp3"); // a long one: never finishes in this test

  const started = (await act({ action: "add", fileIds: ["f0", "f1", "f2"] })).json.player.playback;
  assert.equal(started.preparing, false); // A is ready
  await act({ action: "ended", rev: started.rev }); // B now: still converting
  w.time.now += 8000;
  let pb = await look();
  assert.deepEqual([pb.playing, pb.preparing, pb.positionMs], [true, true, 0]); // nobody can play it yet: it waits
  finishB();
  w.time.now += 3000;
  pb = await look();
  assert.deepEqual([pb.preparing, pb.positionMs], [false, 3000]); // runs from when it was ready

  await act({ action: "ended", rev: pb.rev }); // C: still converting
  w.time.now += 5000;
  assert.deepEqual([(await look()).preparing, (await look()).positionMs], [true, 0]);
  const early = await api.get("/stream/f2"); // gave up waiting: streams while it converts
  assert.deepEqual([early.status, early.headers.get("accept-ranges"), early.text], [200, null, "01234"]);
  w.time.now += 2000;
  pb = await look();
  assert.deepEqual([pb.preparing, pb.positionMs], [false, 2000]); // runs from when it started streaming
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
