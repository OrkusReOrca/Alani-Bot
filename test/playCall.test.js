import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DISCORD_OWNER_0 = "100000000000000001";

const { execute } = await import("../src/features/settings/command.js");
const { getSetting, setSetting } = await import("../src/features/settings/store.js");
const { PLAY_CALL_KEY } = await import("../src/features/settings/definitions.js");
const { makeSession, track } = await import("./helpers/voiceFakes.js");

const OWNER = "100000000000000001";

async function run(words, userId = OWNER) {
  const replies = [];
  await execute({ userId, channelId: "c", guildId: null, reply: async (t) => replies.push(t) }, words.split(" ").filter(Boolean));
  return replies.join("\n");
}

// These tests use the real local settings database: put the setting back afterwards.
const original = getSetting(PLAY_CALL_KEY);
process.on("exit", () => setSetting(PLAY_CALL_KEY, original));

test("PlayCall defaults to on, shows its state, and is switched with on/off (setON/setOFF also accepted)", async () => {
  setSetting(PLAY_CALL_KEY, "on");
  assert.match(await run("playcall"), /PlayCall is \*\*ON\*\* — the voice player posts "Now playing"/);

  assert.match(await run("playcall off"), /PlayCall is now \*\*OFF\*\*.*errors and leave notices still post/);
  assert.equal(getSetting(PLAY_CALL_KEY), "off");
  assert.match(await run("playcall"), /PlayCall is \*\*OFF\*\* — the voice player doesn't post/);

  assert.match(await run("PlayCall ON"), /PlayCall is now \*\*ON\*\*/);
  assert.equal(getSetting(PLAY_CALL_KEY), "on");
  await run("playcall setOFF");
  assert.equal(getSetting(PLAY_CALL_KEY), "off");
  await run("playcall setON");
  assert.equal(getSetting(PLAY_CALL_KEY), "on");
});

test("a bad value shows usage and changes nothing; only owners may use it; it appears in the overview", async () => {
  setSetting(PLAY_CALL_KEY, "on");
  assert.match(await run("playcall maybe"), /Usage/);
  assert.equal(getSetting(PLAY_CALL_KEY), "on");

  assert.match(await run("playcall off", "999999999999999999"), /Unauthorized/);
  assert.equal(getSetting(PLAY_CALL_KEY), "on");

  assert.match(await run(""), /`voice\.playCall` = \*\*on\*\* — PlayCall/);
});

test("with PlayCall off the player stays quiet when a track starts, but still reports problems and leaving", async () => {
  let enabled = false;
  const t = makeSession({ playCall: () => enabled });
  await t.session.join("vc1");

  t.session.add(track("A"));
  t.session.add(track("B"));
  assert.deepEqual(t.announcements, []); // A started, silently
  assert.equal(t.session.isPlaying(), true);

  t.output.failTrack(new Error("decode error")); // A fails; B starts
  assert.equal(t.announcements.length, 1);
  assert.match(t.announcements[0], /Couldn't play \*\*A\*\*/); // problems still post

  enabled = true; // switched back on mid-session: takes effect immediately
  t.output.finishTrack();
  t.session.add(track("C"));
  t.output.finishTrack();
  assert.match(t.announcements.at(-1), /Now playing: \*\*C\*\*/);
});
