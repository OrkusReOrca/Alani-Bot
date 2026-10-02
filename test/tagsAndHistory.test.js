import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DISCORD_OWNER_0 = "100000000000000001";
process.env.DISCORD_OWNER_1 = "100000000000000002";

const tags = await import("../src/features/tags/store.js");
const tagCommand = await import("../src/features/tags/command.js");
const history = await import("../src/features/ai-assistant/history.js");

// Unique IDs per run: these tests use the real local databases.
const salt = String(Date.now());
const friend = `97${salt}`;
const friend2 = `98${salt}`;

function ctx(userId) {
  const replies = [];
  return { userId, channelId: "c", guildId: null, replies, reply: async (t) => replies.push(t) };
}

test("owners hold AIallowed implicitly; others only once granted", () => {
  assert.equal(tags.hasTag("100000000000000001", "AIallowed"), true);
  assert.equal(tags.hasTag("100000000000000002", "AIallowed"), true);
  assert.equal(tags.hasTag(friend, "AIallowed"), false);
});

test("only owners can grant, remove or list a tag", async () => {
  const stranger = ctx(friend);
  await tagCommand.execute(stranger, ["add", "AIallowed", friend]);
  assert.match(stranger.replies[0], /Unauthorized/);
  assert.equal(tags.hasTag(friend, "AIallowed"), false);

  const owner = ctx("100000000000000001");
  await tagCommand.execute(owner, ["add", "aiallowed", friend]); // tag name is case-insensitive
  assert.match(owner.replies[0], /Granted \*\*AIallowed\*\*/);
  assert.equal(tags.hasTag(friend, "AIallowed"), true);

  await tagCommand.execute(owner, ["add", "AIallowed", friend]);
  assert.match(owner.replies[1], /already has/);

  await tagCommand.execute(owner, ["list", "AIallowed"]);
  assert.match(owner.replies[2], new RegExp(`<@${friend}>`));

  await tagCommand.execute(owner, ["remove", "AIallowed", friend]);
  assert.match(owner.replies[3], /Removed/);
  assert.equal(tags.hasTag(friend, "AIallowed"), false);

  await tagCommand.execute(owner, ["remove", "AIallowed", "100000000000000002"]);
  assert.match(owner.replies[4], /bot owner/);
});

test("bad tag or missing user shows usage / a clear error", async () => {
  const owner = ctx("100000000000000001");
  await tagCommand.execute(owner, ["add", "Nonsense", friend]);
  assert.match(owner.replies[0], /Usage/);
  await tagCommand.execute(owner, ["add", "AIallowed"]);
  assert.match(owner.replies[1], /Usage/);
});

test("history records calls and events, and turns them into recent memory for that user only", () => {
  const id = history.startCall({ userId: friend2, channelId: "c", guildId: null, userText: "add reminder x", model: "m" });
  history.recordEvent(id, "command", '.a db add reminder T10:00 "x"');
  history.recordEvent(id, "result", "Added reminder #1");
  history.finishCall(id, { responseText: null, promptTokens: 5, completionTokens: 2 });

  const turns = history.recentTurns(friend2, { limit: 10, withinMs: 60_000 });
  assert.deepEqual(turns, [
    { role: "user", content: "add reminder x" },
    { role: "assistant", content: 'Ran `.a db add reminder T10:00 "x"`\n→ Added reminder #1' },
  ]);

  assert.deepEqual(history.recentTurns(`nobody${salt}`, { limit: 10, withinMs: 60_000 }), []);
  assert.deepEqual(history.recentTurns(friend2, { limit: 10, withinMs: 60_000, now: Date.now() + 2 * 60_000 }), []); // outside the window
});

test("long command replies are clipped in storage", () => {
  const id = history.startCall({ userId: friend2, channelId: "c", guildId: null, userText: "list", model: "m" });
  history.recordEvent(id, "result", "x".repeat(10_000));
  const stored = history.historyDb.prepare(`SELECT content FROM ai_events WHERE call_id = ?`).get(id).content;
  assert.ok(stored.length <= 4001);
});
