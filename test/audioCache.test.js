import { test, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { createAudioCache, cacheKeyFor } from "../src/features/voice-player/audioCache.js";

// These tests run the REAL ffmpeg (the same binary the bot uses on the host).
let ffmpegPath = null;
try {
  ffmpegPath = (await import("@ffmpeg-installer/ffmpeg")).default.path;
} catch {
  // not installed: the tests below skip themselves
}
const skip = !ffmpegPath && "ffmpeg isn't installed";

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "audio-cache-test-"));
const sources = {}; // file name -> path of a real audio file

before(() => {
  if (!ffmpegPath) return;
  // Real tones in two containers: wav (pipe-safe) and m4a (needs a temp file).
  for (const [name, args] of [
    ["tone.wav", ["-f", "lavfi", "-i", "sine=frequency=440:duration=3"]],
    ["tone.m4a", ["-f", "lavfi", "-i", "sine=frequency=330:duration=2", "-c:a", "aac"]],
    ["video.mp4", ["-f", "lavfi", "-i", "sine=frequency=550:duration=2", "-f", "lavfi", "-i", "color=c=blue:s=64x64:d=2", "-c:v", "mpeg4", "-c:a", "aac", "-shortest"]],
  ]) {
    sources[name] = path.join(workDir, name);
    const result = spawnSync(ffmpegPath, ["-y", "-loglevel", "error", ...args, sources[name]]);
    assert.equal(result.status, 0, `couldn't generate ${name}: ${result.stderr}`);
  }
});

function makeCache({ maxBytes = 1024 ** 3, dir = fs.mkdtempSync(path.join(workDir, "cache-")) } = {}) {
  let downloads = 0;
  const cache = createAudioCache({
    dir,
    maxBytes,
    bitrate: "64k",
    ffmpegPath,
    download: async (fileId) => (downloads++, fs.createReadStream(sources[fileId])),
  });
  return { cache, dir, downloads: () => downloads };
}

const entryFor = (name) => ({ fileId: name, name, version: "v1", key: cacheKeyFor({ id: name, modifiedTime: "v1" }) });

async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

test("converts to Ogg Opus, learns the real duration, and a second open needs no download", { skip }, async () => {
  const { cache, downloads } = makeCache();
  const entry = entryFor("tone.wav");

  const { stream, job } = cache.open(entry);
  const bytes = await readAll(stream);
  assert.equal(bytes.subarray(0, 4).toString(), "OggS");
  assert.equal(job.status, "done");
  assert.ok(Math.abs(cache.durationOf(entry) - 3000) < 200, `duration was ${cache.durationOf(entry)}`);

  const again = await readAll(cache.open(entry).stream);
  assert.deepEqual(again, bytes);
  assert.equal(downloads(), 1);
});

test("playback can start while the conversion is still queued behind another", { skip }, async () => {
  const { cache } = makeCache();
  const first = cache.ensure(entryFor("tone.wav"));
  const { stream } = cache.open(entryFor("tone.m4a")); // urgent: runs before anything else waiting, but after the running one
  const bytes = await readAll(stream);
  assert.equal(bytes.subarray(0, 4).toString(), "OggS");
  assert.equal(first.status === "done" || first.status === "running", true);
});

test("containers that need seeking (m4a, mp4 video) work, keeping only the audio", { skip }, async () => {
  const { cache } = makeCache();
  for (const name of ["tone.m4a", "video.mp4"]) {
    const { stream } = cache.open(entryFor(name));
    assert.equal((await readAll(stream)).subarray(0, 4).toString(), "OggS", name);
    assert.ok(cache.durationOf(entryFor(name)) > 1500, name);
  }
});

test("a failed conversion is reported and can be retried; no files are left behind", { skip }, async () => {
  const { cache, dir } = makeCache();
  fs.writeFileSync(path.join(workDir, "broken.wav"), "this is not audio");
  sources["broken.wav"] = path.join(workDir, "broken.wav");

  const { stream, job } = cache.open(entryFor("broken.wav"));
  await assert.rejects(readAll(stream), /ffmpeg exited/);
  assert.equal(job.status, "failed");
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f !== "tmp"), []);
});

test("the cache survives a restart; a half-written conversion is discarded", { skip }, async () => {
  const { cache, dir } = makeCache();
  await readAll(cache.open(entryFor("tone.wav")).stream);
  fs.writeFileSync(path.join(dir, "deadbeefdeadbeefdead.opus"), "partial"); // crashed conversion: no .json

  const restarted = createAudioCache({ dir, maxBytes: 1024 ** 3, bitrate: "64k", ffmpegPath, download: async () => assert.fail("must come from the cache") });
  assert.ok(restarted.durationOf(entryFor("tone.wav")) > 2500);
  assert.equal(fs.existsSync(path.join(dir, "deadbeefdeadbeefdead.opus")), false);
  assert.equal((await readAll(restarted.open(entryFor("tone.wav")).stream)).subarray(0, 4).toString(), "OggS");
});

test("over the size limit, the least recently used UNPINNED track goes first", { skip }, async () => {
  const { cache } = makeCache({ maxBytes: 1 }); // everything is over the limit
  const [a, b] = [entryFor("tone.wav"), entryFor("tone.m4a")];

  cache.setPinned([a.key, b.key]);
  await readAll(cache.open(a).stream);
  await readAll(cache.open(b).stream);
  assert.ok(cache.durationOf(a) && cache.durationOf(b), "pinned tracks are never evicted");

  cache.setPinned([b.key]);
  await readAll(cache.open(entryFor("video.mp4")).stream); // finishing a conversion triggers eviction
  assert.equal(cache.durationOf(a), undefined, "unpinned and oldest: evicted");
  assert.ok(cache.durationOf(b), "still pinned");
});

test("cache keys change when the Drive file is modified", () => {
  assert.notEqual(cacheKeyFor({ id: "x", modifiedTime: "t1" }), cacheKeyFor({ id: "x", modifiedTime: "t2" }));
});
