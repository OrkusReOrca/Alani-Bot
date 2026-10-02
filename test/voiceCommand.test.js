import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DISCORD_OWNER_0 = "100000000000000001";
process.env.DISCORD_OWNER_1 = "100000000000000002";

const { createExecute } = await import("../src/features/voice-player/command.js");
const tags = await import("../src/features/tags/store.js");
const tagCommand = await import("../src/features/tags/command.js");
const { matchByName } = await import("../src/features/voice-player/match.js");
const { makeSession, fakeCache } = await import("./helpers/voiceFakes.js");

const OWNER = "100000000000000001";
const salt = String(Date.now());
const regular = `96${salt}`;
const songMaster = `95${salt}`;

// These tests use the real local settings database: leave nothing behind.
process.on("exit", () => tags.removeTag(songMaster, "SongMaster"));

const FILES = ["Rain Sounds.mp3", "Rainbow Road.mp3", "Lofi Mix.wav"].map((name) => ({ id: `id-${name}`, name, mimeType: "audio/mpeg", modifiedTime: "2026-01-01T00:00:00Z" }));

// One fake server (guild) shared by the commands of a test.
function setup({ durations = {} } = {}) {
  const world = makeSession({ cache: fakeCache(durations) });
  const textChannels = []; // where "Now playing" messages would go, per command
  const execute = createExecute({
    getSession: () => world.session,
    setTextChannel: (guildId, channelId) => textChannels.push(channelId),
    prepareVoice: async () => {},
    findPlayableFile: async (query) => matchByName(FILES, query, (f) => f.name),
  });
  // Runs ".avc <words>" as `user`, who is in voice channel `vc` (or none).
  const run = async (words, { user = regular, vc = "vc1", guildId = "g1" } = {}) => {
    const replies = [];
    await execute({ userId: user, channelId: "text1", guildId, voiceChannelId: vc, reply: async (t) => replies.push(t) }, words.split(" ").filter(Boolean));
    return replies.join("\n");
  };
  return { ...world, run, textChannels };
}

test("tags: SongMaster exists, `.a tag list` shows every tag, `.a tag <TAG> list` shows holders", async () => {
  const owner = { userId: OWNER, channelId: "c", guildId: null, replies: [], reply: async (t) => owner.replies.push(t) };
  await tagCommand.execute(owner, ["list"]);
  assert.match(owner.replies[0], /\*\*AIallowed\*\* — .*\.aii/);
  assert.match(owner.replies[0], /\*\*SongMaster\*\* — .*force play.*removeall/);

  await tagCommand.execute(owner, ["add", "songmaster", songMaster]);
  assert.match(owner.replies[1], /Granted \*\*SongMaster\*\*/);
  await tagCommand.execute(owner, ["SongMaster", "list"]);
  assert.match(owner.replies[2], new RegExp(`Granted:.*<@${songMaster}>`));
  await tagCommand.execute(owner, ["list", "AIallowed"]); // the older form still works
  assert.match(owner.replies[3], /always \(bot owners\)/);

  assert.equal(tags.hasTag(songMaster, "SongMaster"), true);
  assert.equal(tags.hasTag(songMaster, "AIallowed"), false);
  assert.equal(tags.hasTag(regular, "SongMaster"), false);
  assert.equal(tags.hasTag(OWNER, "SongMaster"), true); // owners hold every tag
});

test("join: needs the caller to be in a voice channel; resumes a saved queue", async () => {
  const t = setup();
  assert.match(await t.run("join", { vc: null }), /Join a voice channel first/);
  assert.match(await t.run("join"), /Joined <#vc1>\./);

  await t.run("play lofi");
  await t.run("leave");
  assert.match(await t.run("join"), /resumed the queue \(1 track\)/);
});

test("play: finds a file forgivingly, auto-joins the caller's call, queues at the end", async () => {
  const t = setup();
  assert.match(await t.run("play lofi"), /Playing \*\*Lofi Mix\.wav\*\*/);
  assert.equal(t.session.channelId(), "vc1"); // auto-joined
  assert.match(await t.run("play rain sounds"), /Added \*\*Rain Sounds\.mp3\*\* to the queue \(position 2\)/);
  assert.deepEqual(t.names(), ["Lofi Mix.wav", "Rain Sounds.mp3"]);
  assert.equal(t.textChannels.at(-1), "text1"); // "Now playing" goes to the channel the command came from
});

test("play: unknown file, ambiguous file, no name, not in a call", async () => {
  const t = setup();
  assert.match(await t.run("play jazz"), /No file matching "jazz"/);
  const ambiguous = await t.run("play rain");
  assert.match(ambiguous, /matches several files/);
  assert.match(ambiguous, /Rain Sounds\.mp3/);
  assert.match(ambiguous, /Rainbow Road\.mp3/);
  assert.match(await t.run("play"), /Usage/);
  assert.match(await t.run("play lofi", { vc: null }), /Join a voice channel first/);
  assert.deepEqual(t.names(), []); // none of the failures queued anything
});

test("play from another voice channel is refused while the bot is busy with people elsewhere", async () => {
  const t = setup();
  await t.run("play lofi"); // bot now in vc1 with a person
  assert.match(await t.run("play rain sounds", { vc: "vc2" }), /already playing in <#vc1>/);

  t.output.setHumans(0); // nobody left there: the bot may move
  assert.match(await t.run("play rain sounds", { vc: "vc2" }), /Added|Playing/);
  assert.equal(t.session.channelId(), "vc2");
});

test("controls need you to be in the bot's call", async () => {
  const t = setup();
  assert.match(await t.run("skip"), /not in a voice call/);

  await t.run("play lofi");
  for (const words of ["skip", "pause", "queue loop on", "queue shuffle on", "remove lofi", "leave"]) {
    assert.match(await t.run(words, { vc: "vc2" }), /need to be in my voice channel \(<#vc1>\)/, words);
    assert.match(await t.run(words, { vc: null }), /need to be in my voice channel/, words);
  }
  assert.equal(t.session.isConnected(), true); // nothing happened
});

test("viewing the queue and status is open to anyone, even outside the call", async () => {
  const t = setup({ durations: { "Lofi Mix.wav": 3_600_000, "Rain Sounds.mp3": 125_000 } });
  await t.run("play lofi");
  await t.run("play rain sounds");

  const queue = await t.run("queue", { vc: null });
  assert.match(queue, /\*\*Queue\*\* \(2 tracks, 1:02:05\)/);
  assert.match(queue, /▶ 1\. Lofi Mix\.wav — 1:00:00/);
  assert.match(queue, /2\. Rain Sounds\.mp3 — 2:05/);

  const status = await t.run("status", { vc: null });
  assert.match(status, /Voice: connected to <#vc1>/);
  assert.match(status, /Now playing: \*\*Lofi Mix\.wav\*\*/);
  assert.match(status, /Queue: 2 tracks/);
  assert.match(status, /Loop: \*\*off\*\* · Shuffle: \*\*off\*\*/);
});

test("status when idle and empty", async () => {
  const t = setup();
  assert.match(await t.run("status", { vc: null }), /Voice: not in a call\nNothing is queued\./);
  assert.match(await t.run("queue", { vc: null }), /The queue is empty/);
});

test("loop and shuffle: shuffle on shows loop as on-through-shuffle, and turning loop off while shuffling says so", async () => {
  const t = setup();
  await t.run("play lofi");

  assert.match(await t.run("queue loop on"), /Loop is now \*\*on\*\*/);
  assert.match(await t.run("queue loop off"), /Loop is now \*\*off\*\*/);
  assert.match(await t.run("queue shuffle on"), /Shuffle is now \*\*on\*\*[\s\S]*Loop: \*\*on \(because shuffle is on\)\*\* · Shuffle: \*\*on\*\*/);
  assert.match(await t.run("queue loop off"), /Loop stays active while shuffle is on/);
  assert.match(await t.run("status"), /Loop: \*\*on \(because shuffle is on\)\*\* · Shuffle: \*\*on\*\*/);
  assert.match(await t.run("queue shuffle maybe"), /Usage/);
  assert.match(await t.run("queue loop"), /Usage/);
});

test("pause toggles; skip skips; leave leaves but keeps the queue", async () => {
  const t = setup();
  assert.match(await t.run("play lofi"), /Playing/);
  await t.run("play rain sounds");

  assert.match(await t.run("pause"), /Paused\. Run `\.avc pause` again to resume/);
  assert.match(await t.run("status"), /\(paused\)/);
  assert.match(await t.run("pause"), /Resumed/);
  assert.match(await t.run("skip"), /Skipped \*\*Lofi Mix\.wav\*\*/);
  assert.deepEqual(t.names(), ["Rain Sounds.mp3"]);
  assert.match(await t.run("leave"), /Left the call\. The queue is saved/);
  assert.deepEqual(t.names(), ["Rain Sounds.mp3"]);
});

test("remove: by (partial) name; ambiguous and missing names are explained", async () => {
  const t = setup();
  await t.run("play lofi");
  await t.run("play rain sounds");
  await t.run("play rainbow");

  assert.match(await t.run("remove rain"), /matches several tracks/);
  assert.match(await t.run("remove jazz"), /"jazz" isn't in the queue/);
  assert.match(await t.run("remove rainbow"), /Removed \*\*Rainbow Road\.mp3\*\*/);
  assert.match(await t.run("remove lofi mix"), /Removed \*\*Lofi Mix\.wav\*\*/); // the current one: playback moves on
  assert.deepEqual(t.names(), ["Rain Sounds.mp3"]);
  assert.equal(t.cache.opened.at(-1), "Rain Sounds.mp3");
  assert.match(await t.run("remove"), /Usage/);
});

test("force play needs SongMaster; with it the track plays next and the current is skipped", async () => {
  const t = setup();
  await t.run("play lofi");
  await t.run("play rain sounds");

  assert.match(await t.run("force play rainbow"), /needs the SongMaster tag/);
  assert.deepEqual(t.names(), ["Lofi Mix.wav", "Rain Sounds.mp3"]);

  assert.match(await t.run("force play rainbow road", { user: songMaster }), /Playing \*\*Rainbow Road\.mp3\*\* next \(skipped the current track\)/);
  assert.deepEqual(t.names(), ["Rainbow Road.mp3", "Rain Sounds.mp3"]);
  assert.equal(t.cache.opened.at(-1), "Rainbow Road.mp3");

  assert.match(await t.run("force play lofi", { user: OWNER }), /Playing/); // owners hold every tag
  assert.match(await t.run("force", { user: songMaster }), /Usage/);
  assert.match(await t.run("force play", { user: songMaster }), /Usage/);
});

test("removeall needs SongMaster, and works without being in the call", async () => {
  const t = setup();
  await t.run("play lofi");
  await t.run("play rain sounds");

  assert.match(await t.run("removeall"), /needs the SongMaster tag/);
  assert.equal(t.names().length, 2);

  assert.match(await t.run("removeall", { user: songMaster, vc: null }), /Cleared the queue \(2 tracks\)/);
  assert.deepEqual(t.names(), []);
  assert.match(await t.run("removeall", { user: songMaster }), /already empty/);
});

test("server only, and unknown subcommands show usage", async () => {
  const t = setup();
  assert.match(await t.run("play lofi", { guildId: null }), /only works in a server/);
  assert.match(await t.run(""), /Usage/);
  assert.match(await t.run("dance"), /Usage/);
});

test("a join that fails is reported, not thrown", async () => {
  const t = setup();
  assert.match(await t.run("join", { vc: "bad" }), /Couldn't join your voice channel: timed out/);
});

test("queue playcall on/off: per-server, needs the bot's call, shows in status, and silences 'Now playing'", async () => {
  const t = setup();
  assert.match(await t.run("queue playcall off"), /not in a voice call/); // not in a call yet
  await t.run("play lofi");
  assert.match(t.announcements.join("\n"), /Now playing: \*\*Lofi Mix\.wav\*\*/);

  assert.match(await t.run("queue playcall off", { vc: "vc2" }), /need to be in my voice channel/);
  assert.match(await t.run("queue playcall off"), /PlayCall is now \*\*off\*\*\.\nLoop: \*\*off\*\* · Shuffle: \*\*off\*\* · PlayCall: \*\*off\*\*/);
  assert.match(await t.run("status", { vc: null }), /PlayCall: \*\*off\*\*/);

  const before = t.announcements.length;
  await t.run("play rain sounds");
  await t.run("skip"); // Rain Sounds starts: silently
  assert.equal(t.announcements.length, before);

  assert.match(await t.run("queue playcall on"), /PlayCall is now \*\*on\*\*/);
  assert.match(await t.run("queue playcall maybe"), /Usage:.*playcall on\|off/);
});

test("queue persistent: bot owners only (not even SongMaster), needs the bot's call, shows in status", async () => {
  const t = setup();
  await t.run("play lofi");

  assert.match(await t.run("queue persistent on"), /Only a bot owner can change Persistent/);
  assert.match(await t.run("queue persistent on", { user: songMaster }), /Only a bot owner can change Persistent/);
  assert.equal(t.store.loadState("g1").persistent, false);

  assert.match(await t.run("queue persistent on", { user: OWNER, vc: "vc2" }), /need to be in my voice channel/);
  assert.match(await t.run("queue persistent on", { user: OWNER }), /Persistent is now \*\*on\*\*\.\nLoop: .*Persistent: \*\*on\*\*/);
  assert.equal(t.store.loadState("g1").persistent, true);
  assert.match(await t.run("status", { vc: null }), /Persistent: \*\*on\*\*/);

  assert.match(await t.run("queue persistent off", { user: songMaster }), /Only a bot owner/); // can't turn it off either
  assert.match(await t.run("queue persistent off", { user: OWNER }), /Persistent is now \*\*off\*\*/);
  assert.match(await t.run("queue persistent maybe", { user: OWNER }), /Usage:.*persistent on\|off/);
});

test("short forms: every subcommand and queue setting has one, and the long names still work", async () => {
  const t = setup({ durations: { "Lofi Mix.wav": 60_000 } });

  assert.match(await t.run("j"), /Joined <#vc1>/);
  assert.match(await t.run("p lofi"), /Playing \*\*Lofi Mix\.wav\*\*/);
  assert.match(await t.run("p rain sounds"), /Added \*\*Rain Sounds\.mp3\*\* to the queue/);
  assert.match(await t.run("q"), /\*\*Queue\*\* \(2 tracks/);
  assert.match(await t.run("st", { vc: null }), /Voice: connected/);
  assert.match(await t.run("pa"), /Paused/);
  assert.match(await t.run("pa"), /Resumed/);

  assert.match(await t.run("q lp on"), /Loop is now \*\*on\*\*/);
  assert.match(await t.run("q sh on"), /Shuffle is now \*\*on\*\*/);
  assert.match(await t.run("q pc off"), /PlayCall is now \*\*off\*\*/);
  assert.match(await t.run("q ps on", { user: OWNER }), /Persistent is now \*\*on\*\*/);
  assert.match(await t.run("queue loop off"), /Loop is now \*\*off\*\*/); // long forms alongside short ones
  assert.match(await t.run("QUEUE LP ON"), /Loop is now \*\*on\*\*/); // case-insensitive

  assert.match(await t.run("sk"), /Skipped/);
  assert.match(await t.run("rm rain"), /Removed \*\*Rain Sounds\.mp3\*\*/);
  assert.match(await t.run("lv"), /Left the call/);
});

test("short forms of the privileged commands: fp / f p force play, rma removeall", async () => {
  const t = setup();
  await t.run("p lofi");
  await t.run("p rain sounds");

  assert.match(await t.run("fp rainbow"), /needs the SongMaster tag/);
  assert.match(await t.run("fp rainbow road", { user: songMaster }), /Playing \*\*Rainbow Road\.mp3\*\* next/);
  assert.match(await t.run("f p lofi", { user: songMaster }), /Playing \*\*Lofi Mix\.wav\*\* next/);
  assert.match(await t.run("force p rain sounds", { user: songMaster }), /Playing \*\*Rain Sounds\.mp3\*\* next/);
  assert.match(await t.run("fp", { user: songMaster }), /Usage/);
  assert.match(await t.run("f", { user: songMaster }), /Usage/);

  assert.match(await t.run("rma"), /needs the SongMaster tag/);
  assert.match(await t.run("rma", { user: songMaster }), /Cleared the queue/);
});

test("list has short forms too, and unknown words still show usage", async () => {
  const t = setup();
  assert.match(await t.run("dance"), /Usage/);
  assert.match(await t.run("pc"), /Usage/); // pc is a queue setting, not a top-level command
});
