import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DISCORD_OWNER_0 = "111111111111111111";
const OWNER = "111111111111111111";
const STRANGER = "222222222222222222";
const CHANNEL = "333333333333333333";

const { config } = await import("../src/features/emotion-detect/config.js");
const { execute, dashboardOnline } = await import("../src/features/emotion-detect/command.js");
const { formatWebSaveSummary, formatWebSaveTimings } = await import("../src/features/emotion-detect/emotionApi.js");

function makeCtx(userId = OWNER, channelId = CHANNEL) {
  const replies = [];
  return { replies, userId, channelId, reply: async (text) => replies.push(text) };
}

test("dashboardOnline: true only for an answering /api/health", async () => {
  const seen = [];
  const ok = async (url) => (seen.push(url), { ok: true });
  assert.equal(await dashboardOnline("https://x.example/", ok), true);
  assert.equal(seen[0], "https://x.example/api/health");
  assert.equal(await dashboardOnline("https://x.example", async () => ({ ok: false })), false);
  assert.equal(await dashboardOnline("https://x.example", async () => { throw new Error("dns"); }), false);
});

test(".a emo web: replies with the dashboard link and its status, same permission rules as the rest", async () => {
  config.channelId = CHANNEL;
  config.webUrl = "https://alaniemotion.apps.bot-hosting.cloud/";
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: true });
    const online = makeCtx();
    await execute(online, ["web"]);
    assert.match(online.replies[0], /<https:\/\/alaniemotion\.apps\.bot-hosting\.cloud\/app\/>/);
    assert.match(online.replies[0], /Online/);
    assert.doesNotMatch(online.replies[0], /password is/i); // never prints the password

    globalThis.fetch = async () => { throw new Error("down"); };
    const offline = makeCtx();
    await execute(offline, ["web"]);
    assert.match(offline.replies[0], /Not answering/);

    const denied = makeCtx(STRANGER);
    await execute(denied, ["web"]);
    assert.match(denied.replies[0], /permission/);

    const elsewhere = makeCtx(OWNER, "999999999999999999");
    await execute(elsewhere, ["web"]);
    assert.deepEqual(elsewhere.replies, []); // silent outside the emotion channel, like every .a emo form

    config.webUrl = undefined;
    const unset = makeCtx();
    await execute(unset, ["web"]);
    assert.match(unset.replies[0], /EMOTION_WEB_URL/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a 503 from the slot (dashboard on) is explained instead of shown raw", async () => {
  config.channelId = CHANNEL;
  config.serviceUrl = "https://slot.example";
  config.serviceSecret = "secret";
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: false, status: 503, statusText: "Service Unavailable", text: async () => '{"error":"x"}' });
    const ctx = makeCtx();
    await execute(ctx, ["run1", "mAU", "d"]);
    assert.match(ctx.replies[0], /web dashboard is active/);
    assert.match(ctx.replies[0], /\.a emo web/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("web-save summary: file, prediction, modalities, clip length, raw answers; nobody gets pinged", () => {
  const text = formatWebSaveSummary({
    fileName: "me @everyone.mp4", prediction: "Positive_Activate (PA)", modalities: ["AU", "T"], cacheMode: "d",
    clipSeconds: 120, truncated: true, valenceRaw: "positive", arousalRaw: "active",
  });
  assert.match(text, /^\*\*me @​everyone\.mp4\*\* → \*\*Positive_Activate \(PA\)\*\*/);
  assert.match(text, /Modalities: \*\*AU \+ T\*\* \(all five cached\)/);
  assert.match(text, /the first 2:00 of the clip/);
  assert.match(text, /valence `positive`, arousal `active`/);
});

test("web-save timings: readable stage names, total last", () => {
  const text = formatWebSaveTimings({ total: 61.234, face: 30.5, vlm_valence: 4 });
  const lines = text.split("\n");
  assert.equal(lines[0], "**Timing**");
  assert.equal(lines.at(-1), "• Total: 61.2 s");
  assert.ok(lines.includes("• Face (action units, gaze, head pose): 30.5 s"));
  assert.equal(formatWebSaveTimings({}), null);
});
