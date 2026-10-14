import { test } from "node:test";
import assert from "node:assert/strict";

const { execute, OFFICIAL_SITE_MESSAGE } = await import("../src/features/info/command.js");

const makeCtx = (guildId = null) => {
  const replies = [];
  return { replies, guildId, reply: async (text) => replies.push(text) };
};

test("plain .a info starts with the official-site link, as its own first message, then the usual info", async () => {
  const ctx = makeCtx();
  await execute(ctx, []);
  assert.equal(ctx.replies.length, 2);
  assert.equal(ctx.replies[0], OFFICIAL_SITE_MESSAGE);
  assert.match(ctx.replies[0], /For more details, visit our official site: https:\/\/alatomy\.com\/alani\/discord$/);
  assert.match(ctx.replies[1], /Hi, I'm Alani/);
  assert.ok(!ctx.replies[1].includes("alatomy.com"), "the link is only in the first message");
});

test("the topic pages do not repeat the link", async () => {
  for (const topic of ["db", "avc", "at"]) {
    const ctx = makeCtx();
    await execute(ctx, [topic]);
    assert.ok(ctx.replies.length >= 1, topic);
    assert.ok(!ctx.replies.some((text) => text.includes(OFFICIAL_SITE_MESSAGE)), `${topic} should not carry the site message`);
  }
});

test("a private topic asked outside the private server falls back to the normal info, link included", async () => {
  const ctx = makeCtx("123456789012345678");
  await execute(ctx, ["emo"]);
  assert.equal(ctx.replies[0], OFFICIAL_SITE_MESSAGE);
});
