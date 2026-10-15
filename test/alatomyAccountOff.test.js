import { test } from "node:test";
import assert from "node:assert/strict";

// With no service configured the feature is off and must not disturb anything else.
delete process.env.ALATOMY_ACCOUNT_API_URL;
delete process.env.ALATOMY_ACCOUNT_API_SECRET;

const { execute } = await import("../src/features/db/command.js");
const { execute: accountExecute } = await import("../src/features/alatomy-account/command.js");
const { startAccountReminderScheduler } = await import("../src/features/alatomy-account/scheduler.js");

const ctxFor = () => {
  const replies = [];
  return { replies, userId: "111111111111111111", channelId: "1", guildId: null, reply: async (t) => replies.push(t) };
};

test("`.a db alatomy` and `.a account` explain that it is not connected", async () => {
  const a = ctxFor();
  await execute(a, ["alatomy", "list", "reminders"]);
  assert.match(a.replies[0], /aren't connected/);
  const b = ctxFor();
  await accountExecute(b);
  assert.match(b.replies[0], /aren't connected/);
});

test("the scheduler does not start", () => {
  assert.equal(startAccountReminderScheduler(), null);
});
