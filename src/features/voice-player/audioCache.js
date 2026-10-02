// Converted-audio cache for the voice player.
//
// Every track is converted ONCE to Opus-in-Ogg (what Discord plays natively, so
// playback needs almost no CPU) and kept on disk:
//
//   <dir>/<key>.opus   the audio, written progressively while ffmpeg runs
//   <dir>/<key>.json   written only when the conversion FINISHES — its presence
//                      is what marks the .opus complete (a lone .opus is a
//                      crashed conversion and is deleted at startup)
//
// A track can start playing while it is still converting: open() hands back a
// stream that reads the growing file and waits for more as it's written. That
// is how a 1-hour file starts in seconds. Video files keep only their audio.
//
// Conversions run one at a time, in the order requested (urgent ones first).
// Tracks currently in a queue are "pinned"; when the cache exceeds its size
// limit the least-recently-used UNPINNED tracks are deleted.
//
// ffmpeg input: audio formats that can be streamed are piped straight from
// Drive. Containers that need seeking (mp4/m4a/mov — their index may sit at
// the end of the file) are downloaded to a temp file first; a piped conversion
// that fails before producing anything is retried that way too.

import { spawn as nodeSpawn } from "child_process";
import crypto from "crypto";
import { EventEmitter } from "events";
import fs from "fs";
import path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";

const PIPE_SAFE_EXTENSIONS = new Set(["mp3", "wav", "flac", "ogg", "oga", "opus", "webm", "aac", "mka"]);
const ERROR_TAIL_LINES = 5;

export function cacheKeyFor(file) {
  return crypto.createHash("sha1").update(`${file.id}|${file.modifiedTime}`).digest("hex").slice(0, 20);
}

const extensionOf = (name) => name.split(".").pop().toLowerCase();
const canPipe = (entry) => PIPE_SAFE_EXTENSIONS.has(extensionOf(entry.name));

class Job extends EventEmitter {
  constructor(entry) {
    super();
    this.entry = entry;
    this.status = "pending"; // pending | running | done | failed
    this.bytes = 0; // bytes safely on disk so far
    this.durationMs = undefined;
    this.error = null;
    this.setMaxListeners(0);
  }

  changed() {
    this.emit("change");
  }

  waitForChange() {
    return new Promise((resolve) => this.once("change", resolve));
  }
}

// A stream over a file that may still be growing: serves what's on disk, then
// waits for more until the job is done.
class GrowingFileReader extends Readable {
  constructor(filePath, job) {
    super({ highWaterMark: 64 * 1024 });
    this.filePath = filePath;
    this.job = job;
    this.handle = null;
    this.position = 0;
  }

  async _read(size) {
    try {
      for (;;) {
        if (this.position < this.job.bytes) {
          // Opened lazily: the file doesn't exist until the conversion has written something.
          this.handle ??= await fs.promises.open(this.filePath, "r");
          const buffer = Buffer.alloc(Math.min(size, this.job.bytes - this.position));
          const { bytesRead } = await this.handle.read(buffer, 0, buffer.length, this.position);
          this.position += bytesRead;
          this.push(buffer.subarray(0, bytesRead));
          return;
        }
        if (this.job.status === "done") return void this.push(null);
        if (this.job.status === "failed") return void this.destroy(this.job.error);
        await this.job.waitForChange();
      }
    } catch (err) {
      this.destroy(err);
    }
  }

  _destroy(err, callback) {
    (this.handle?.close() ?? Promise.resolve()).catch(() => {}).finally(() => callback(err));
  }
}

// download: (fileId) => Promise<Readable>
export function createAudioCache({ dir, maxBytes, bitrate, ffmpegPath, download, spawn = nodeSpawn }) {
  const tempDir = path.join(dir, "tmp");
  const audioPath = (key) => path.join(dir, `${key}.opus`);
  const metaPath = (key) => path.join(dir, `${key}.json`);

  const index = new Map(); // key -> { key, bytes, durationMs, name, lastUsed } for COMPLETE tracks
  const jobs = new Map(); // key -> Job (pending, running, or done in this session)
  const pending = []; // Jobs waiting to run
  let running = null;
  let pinned = new Set();

  // ---------- startup ----------
  function init() {
    fs.mkdirSync(tempDir, { recursive: true });
    for (const file of fs.readdirSync(tempDir)) fs.rmSync(path.join(tempDir, file), { force: true });

    for (const file of fs.readdirSync(dir)) {
      const [key, extension] = file.split(".");
      if (extension === "opus" && !fs.existsSync(metaPath(key))) fs.rmSync(path.join(dir, file), { force: true });
      if (extension === "json") {
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath(key), "utf8"));
          index.set(key, { ...meta, lastUsed: fs.statSync(metaPath(key)).mtimeMs });
        } catch {
          fs.rmSync(metaPath(key), { force: true });
        }
      }
    }
    evict();
  }

  // ---------- eviction ----------
  function totalBytes() {
    return [...index.values()].reduce((sum, item) => sum + item.bytes, 0);
  }

  function evict() {
    const evictable = [...index.values()].filter((item) => !pinned.has(item.key)).sort((a, b) => a.lastUsed - b.lastUsed);
    let total = totalBytes();
    for (const item of evictable) {
      if (total <= maxBytes) break;
      fs.rmSync(audioPath(item.key), { force: true });
      fs.rmSync(metaPath(item.key), { force: true });
      index.delete(item.key);
      jobs.delete(item.key);
      total -= item.bytes;
    }
  }

  function touch(key) {
    const item = index.get(key);
    if (!item) return;
    item.lastUsed = Date.now();
    const now = new Date();
    fs.utimes(metaPath(key), now, now, () => {});
  }

  // ---------- conversion ----------
  async function convert(job, { fromTempFile }) {
    const { entry } = job;
    const key = entry.key;
    let input = "pipe:0";
    let tempPath = null;

    if (fromTempFile) {
      tempPath = path.join(tempDir, `${key}.src`);
      await pipeline(await download(entry.fileId), fs.createWriteStream(tempPath));
      input = tempPath;
    }

    try {
      await new Promise((resolve, reject) => {
        const ffmpeg = spawn(
          ffmpegPath,
          ["-hide_banner", "-loglevel", "error", "-progress", "pipe:2", "-i", input, "-vn", "-map", "0:a:0", "-c:a", "libopus", "-b:a", bitrate, "-ar", "48000", "-ac", "2", "-f", "ogg", "pipe:1"],
          { stdio: [fromTempFile ? "ignore" : "pipe", "pipe", "pipe"] }
        );
        const out = fs.createWriteStream(audioPath(key));
        let lastTimeUs = 0;
        const errorTail = [];
        let settled = false;
        const fail = (err) => {
          if (settled) return;
          settled = true;
          ffmpeg.kill("SIGKILL");
          out.destroy();
          reject(err);
        };

        if (!fromTempFile) {
          ffmpeg.stdin.on("error", () => {}); // ffmpeg closing its input early is reported by its exit code
          download(entry.fileId).then((source) => {
            source.on("error", fail);
            source.pipe(ffmpeg.stdin);
          }, fail);
        }

        ffmpeg.stdout.on("data", (chunk) => {
          const ok = out.write(chunk, () => {
            job.bytes += chunk.length;
            job.changed();
          });
          if (!ok) {
            ffmpeg.stdout.pause();
            out.once("drain", () => ffmpeg.stdout.resume());
          }
        });

        let stderrBuffer = "";
        ffmpeg.stderr.on("data", (chunk) => {
          stderrBuffer += chunk;
          const lines = stderrBuffer.split(/\r?\n/);
          stderrBuffer = lines.pop();
          for (const line of lines) {
            const progress = /^out_time_(?:us|ms)=(\d+)$/.exec(line);
            if (progress) lastTimeUs = Number(progress[1]);
            else if (!/^[a-z_0-9]+=/.test(line) && line.trim()) errorTail.push(line.trim());
          }
          errorTail.splice(0, Math.max(0, errorTail.length - ERROR_TAIL_LINES));
        });

        ffmpeg.on("error", fail);
        ffmpeg.on("close", (code) => {
          out.end(() => {
            if (settled) return;
            settled = true;
            if (code === 0) resolve({ durationMs: Math.round(lastTimeUs / 1000) });
            else reject(new Error(`ffmpeg exited with code ${code}: ${errorTail.join(" | ") || "no details"}`));
          });
        });
      }).then((result) => {
        job.durationMs = result.durationMs;
      });
    } finally {
      if (tempPath) fs.rmSync(tempPath, { force: true });
    }
  }

  async function runJob(job) {
    job.status = "running";
    job.changed();
    const key = job.entry.key;
    try {
      try {
        await convert(job, { fromTempFile: !canPipe(job.entry) });
      } catch (err) {
        // A piped conversion that produced nothing probably needed a seekable
        // input; retry once from a temp file.
        if (canPipe(job.entry) && job.bytes === 0) await convert(job, { fromTempFile: true });
        else throw err;
      }
      const meta = { key, name: job.entry.name, bytes: job.bytes, durationMs: job.durationMs };
      fs.writeFileSync(metaPath(key), JSON.stringify(meta));
      index.set(key, { ...meta, lastUsed: Date.now() });
      job.status = "done";
    } catch (err) {
      fs.rmSync(audioPath(key), { force: true });
      job.error = err;
      job.status = "failed";
      jobs.delete(key);
    }
    job.changed();
  }

  async function pump() {
    if (running || pending.length === 0) return;
    running = pending.shift();
    await runJob(running);
    running = null;
    evict();
    pump();
  }

  // ---------- public ----------
  init();

  return {
    // Starts (or finds) the conversion of `entry`; returns its Job. Already-
    // converted tracks come back as a finished job. urgent: jump the line.
    ensure(entry, { urgent = false } = {}) {
      const existing = jobs.get(entry.key);
      if (existing && existing.status !== "failed") {
        if (urgent && existing.status === "pending") {
          pending.splice(pending.indexOf(existing), 1);
          pending.unshift(existing);
        }
        return existing;
      }

      const job = new Job(entry);
      const meta = index.get(entry.key);
      if (meta) {
        job.status = "done";
        job.bytes = meta.bytes;
        job.durationMs = meta.durationMs;
        touch(entry.key);
        jobs.set(entry.key, job);
        return job;
      }

      jobs.set(entry.key, job);
      pending[urgent ? "unshift" : "push"](job);
      pump();
      return job;
    },

    // A readable Ogg-Opus stream of the track; starts the conversion if needed.
    // Returns { stream, job }.
    open(entry, options) {
      const job = this.ensure(entry, { urgent: true, ...options });
      touch(entry.key);
      return { job, stream: job.status === "done" ? fs.createReadStream(audioPath(entry.key)) : new GrowingFileReader(audioPath(entry.key), job) };
    },

    // Length in ms once the track is converted, else undefined.
    durationOf(entry) {
      return index.get(entry.key)?.durationMs;
    },

    // The keys of every track currently in some queue — these are never evicted.
    setPinned(keys) {
      pinned = new Set(keys);
    },

    stats: () => ({ tracks: index.size, bytes: totalBytes(), pending: pending.length, converting: running?.entry.name ?? null }),
  };
}
