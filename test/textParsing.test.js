import { test } from "node:test";
import assert from "node:assert/strict";
import { extractQuoted, normalizeText, stripTrailingModifiers } from "../src/common/textParsing.js";

test("extractQuoted re-joins a quoted field split across tokens", () => {
  assert.deepEqual(extractQuoted(["2026-09-24T10:00", '"pay', "the", 'rent"', "force"]), {
    before: ["2026-09-24T10:00"],
    text: "pay the rent",
    after: ["force"],
  });
  assert.equal(extractQuoted(["no", "quotes"]), null);
  assert.equal(extractQuoted(['"unterminated', "text"]), null);
});

test("normalizeText ignores case and repeated whitespace", () => {
  assert.equal(normalizeText("  Buy   MILK "), "buy milk");
});

test("stripTrailingModifiers peels force, a channel id and (for reminders) mentions, in any order", () => {
  assert.deepEqual(stripTrailingModifiers(["alice,bob", "123456789012345678", "force"], { allowMentions: true }), {
    rest: [],
    force: true,
    channelId: "123456789012345678",
    mentions: "alice,bob",
  });
  // Without allowMentions, a non-modifier token is left alone.
  assert.deepEqual(stripTrailingModifiers(["alice"], {}), { rest: ["alice"], force: false, channelId: null, mentions: null });
});
