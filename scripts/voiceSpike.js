// THROWAWAY host test: can this deployment join a Discord voice call and play
// audio? Run it INSTEAD of the bot (set the panel's Startup File to
// scripts/voiceSpike.js, restart, then set it back to src/bot.js).
//
// It checks, in order, and posts the report to the command-box channel:
//   1. the voice packages load (Opus encoder, encryption, E2EE, ffmpeg binary)
//   2. the bot reaches "Ready" in a voice channel (needs outbound UDP)
//   3. audio actually plays — you should HEAR two beeps: a low one (made by
//      ffmpeg, tests the ffmpeg path) then a high one (raw audio through the
//      Opus encoder, tests the encoder without ffmpeg)
//
// Join any voice channel in the same server as the bot (as DISCORD_OWNER_0)
// before or within 3 minutes of starting it. Nothing here touches any data.

import { spawn } from "child_process";
import { Readable } from "stream";
import { Client, GatewayIntentBits } from "discord.js";
import { readEnv } from "../src/common/env.js";
import { sendViaBotChannel } from "../src/common/discordApi.js";

const WAIT_FOR_USER_MS = 3 * 60 * 1000;
const READY_TIMEOUT_MS = 30 * 1000;
const BEEP_SECONDS = 4;

const token = readEnv("DISCORD_BOT_TOKEN");
const ownerId = readEnv("DISCORD_OWNER_0");
const reportChannelId = readEnv("DISCORD_COMMAND_BOX");
if (!token || !ownerId) {
  console.error("Needs DISCORD_BOT_TOKEN and DISCORD_OWNER_0.");
  process.exit(1);
}

const report = [];
const note = (line) => {
  console.log(line);
  report.push(line);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function finish(code) {
  const text = ["**Voice spike report**", ...report.map((l) => `• ${l}`)].join("\n");
  if (reportChannelId) await sendViaBotChannel(token, reportChannelId, text).catch((e) => console.error("couldn't post report:", e.message));
  process.exit(code);
}

// ---------- 1. packages ----------
async function tryLoad(label, load) {
  try {
    const result = await load();
    note(`✅ ${label}${result ? ` — ${result}` : ""}`);
    return true;
  } catch (err) {
    note(`❌ ${label} — ${err.message.split("\n")[0]}`);
    return false;
  }
}

async function checkPackages() {
  const voice = await tryLoad("@discordjs/voice", async () => (await import("@discordjs/voice")).generateDependencyReport().split("\n").filter((l) => /^(Opus|Encryption|DAVE|FFmpeg)/i.test(l) || /^- /.test(l)).join(" | "));
  const opus = await tryLoad("opusscript (Opus encoder)", async () => (await import("opusscript")) && "loaded");
  const sodium = await tryLoad("libsodium-wrappers (encryption)", async () => {
    const mod = await import("libsodium-wrappers");
    await (mod.default ?? mod).ready;
    return "loaded";
  });
  await tryLoad("@snazzah/davey (call end-to-end encryption)", async () => (await import("@snazzah/davey")) && "loaded");

  let ffmpegPath = null;
  await tryLoad("ffmpeg binary", async () => {
    ffmpegPath = (await import("@ffmpeg-installer/ffmpeg")).default.path;
    const version = await new Promise((resolve, reject) => {
      const proc = spawn(ffmpegPath, ["-version"]);
      let out = "";
      proc.stdout.on("data", (d) => (out += d));
      proc.on("error", reject);
      proc.on("close", (code) => (code === 0 ? resolve(out.split("\n")[0]) : reject(new Error(`exit ${code}`))));
    });
    return version;
  });

  return { ok: voice && opus && sodium, ffmpegPath };
}

// ---------- 3. beeps ----------
function ffmpegBeep(ffmpegPath, frequency) {
  const proc = spawn(ffmpegPath, ["-f", "lavfi", "-i", `sine=frequency=${frequency}:duration=${BEEP_SECONDS}`, "-c:a", "libopus", "-b:a", "64k", "-f", "ogg", "pipe:1"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  return proc.stdout;
}

// 48 kHz stereo signed 16-bit little-endian sine wave.
function rawBeep(frequency) {
  const sampleRate = 48000;
  const samples = sampleRate * BEEP_SECONDS;
  const buffer = Buffer.alloc(samples * 4);
  for (let i = 0; i < samples; i++) {
    const value = Math.round(Math.sin((2 * Math.PI * frequency * i) / sampleRate) * 8000);
    buffer.writeInt16LE(value, i * 4);
    buffer.writeInt16LE(value, i * 4 + 2);
  }
  return Readable.from([buffer]);
}

async function play(voice, player, resource, label) {
  const started = Date.now();
  player.play(resource);
  await voice.entersState(player, voice.AudioPlayerStatus.Playing, 10_000);
  note(`✅ ${label} started playing after ${Date.now() - started} ms`);
  await voice.entersState(player, voice.AudioPlayerStatus.Idle, (BEEP_SECONDS + 10) * 1000);
}

// ---------- main ----------
const packages = await checkPackages();
if (!packages.ok) {
  note("⛔ Stopping: a required voice package didn't load, so the host can't do voice with these packages.");
  await finish(1);
}

const voice = await import("@discordjs/voice");
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
await client.login(token);
await new Promise((resolve) => client.once("clientReady", resolve));
note(`✅ logged in as ${client.user.tag}`);

// Find the owner's voice channel; wait for them to join one.
const deadline = Date.now() + WAIT_FOR_USER_MS;
let channel = null;
console.log("Waiting for the owner to be in a voice channel…");
while (!channel && Date.now() < deadline) {
  for (const guild of client.guilds.cache.values()) {
    const state = guild.voiceStates.cache.get(ownerId);
    if (state?.channel) channel = state.channel;
  }
  if (!channel) await sleep(2000);
}
if (!channel) {
  note("⛔ Gave up: you weren't in a voice channel within 3 minutes (join one, then restart).");
  await finish(1);
}
note(`Joining "${channel.name}" in "${channel.guild.name}"…`);

const connection = voice.joinVoiceChannel({
  channelId: channel.id,
  guildId: channel.guild.id,
  adapterCreator: channel.guild.voiceAdapterCreator,
  selfDeaf: true,
});
connection.on("stateChange", (from, to) => console.log(`voice connection: ${from.status} -> ${to.status}`));

const joinStarted = Date.now();
try {
  await voice.entersState(connection, voice.VoiceConnectionStatus.Ready, READY_TIMEOUT_MS);
  note(`✅ voice connection Ready after ${Date.now() - joinStarted} ms (UDP and encryption handshake work)`);
} catch {
  note(`❌ voice connection never became Ready (stuck at "${connection.state.status}") — most likely outbound UDP is blocked on this host`);
  connection.destroy();
  await finish(1);
}

const player = voice.createAudioPlayer();
connection.subscribe(player);
note("🔊 Listen now: you should hear a LOW beep, then a HIGH beep.");

try {
  if (packages.ffmpegPath) {
    await play(voice, player, voice.createAudioResource(ffmpegBeep(packages.ffmpegPath, 440), { inputType: voice.StreamType.OggOpus }), "low beep (ffmpeg -> Opus)");
  } else {
    note("⚠️ skipped the low beep: no ffmpeg binary");
  }
  await play(voice, player, voice.createAudioResource(rawBeep(880), { inputType: voice.StreamType.Raw }), "high beep (raw audio -> Opus encoder)");
  note("Done. Tell Claude which beeps you heard.");
} catch (err) {
  note(`❌ playback failed: ${err.message}`);
}

connection.destroy();
await finish(0);
