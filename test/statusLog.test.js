import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DISCORD_BOT_TOKEN = "bot-token";
process.env.DISCORD_STATUS_CHANNEL = "1552560904615497808";

const status = await import("../src/common/statusLog.js");
const { formatTimeline } = await import("../src/features/emotion-detect/emotionApi.js");
const { formatIctDateTime } = await import("../src/common/time.js");

function captureMessages() {
  const sent = [];
  globalThis.fetch = async (url, options) => {
    sent.push({ url: String(url), content: JSON.parse(options.body).content });
    return new Response(JSON.stringify({ id: "1" }));
  };
  return sent;
}

test("ICT formatting: DD/MM/YYYY HH:MM, 24h, rolls the date over at UTC+7", () => {
  assert.equal(formatIctDateTime(Date.UTC(2026, 8, 24, 17, 5)), "25/09/2026 00:05");
  assert.equal(formatIctDateTime(Date.UTC(2026, 8, 24, 6, 59, 9), { seconds: true }), "24/09/2026 13:59:09");
});

test("status lines go to the status channel as '<emoji> <time> == <text>'", async () => {
  const sent = captureMessages();
  await status.statusOnline();
  await status.statusFortnite();
  await status.statusUniversity();

  assert.match(sent[0].url, /channels\/1552560904615497808\/messages$/);
  assert.match(sent[0].content, /^🟢 \d{2}\/\d{2}\/\d{4} \d{2}:\d{2} == Online, Alani bot$/);
  assert.match(sent[1].content, /^🇫 .* == Fortnite tracker sent$/);
  assert.match(sent[2].content, /^🇺 .* == University tracker updated$/);
});

test("an unexpected shutdown is stamped with the time the bot was last seen", async () => {
  const sent = captureMessages();
  await status.statusOffline({ at: Date.UTC(2026, 8, 24, 3, 0), unexpected: true });
  assert.equal(sent[0].content, "🔴 24/09/2026 10:00 == Offline, Alani bot (shut down unexpectedly)");
});

test("database lines carry the names, and a fault line pings the owner", async () => {
  const sent = captureMessages();
  await status.statusDatabaseCreated({ name: "Trips", server: "Home", user: "khun" });
  await status.statusDatabaseUpdated({ name: "Trips", change: "new reminder", itemName: "pay rent", user: "khun" });
  await status.statusCloudFaulty("DB Backup", { ping: "<@42>" });
  await status.statusEmotionCalled("runany, 3 clip(s)");

  assert.match(sent[0].content, /== Database \*\*Created\*\* name \*\*\*Trips\*\*\* at \*Home\* by \*khun\*$/);
  assert.match(sent[1].content, /== Database \*\*Updated\*\* for \*\*\*Trips\*\*\* being \*new reminder\* name \*pay rent\* by \*khun\*$/);
  assert.match(sent[2].content, /^☁️‼️ .* == Faulty cloud update \(DB Backup\) <@42>$/);
  assert.match(sent[3].content, /^🍋 .* == Emotion recognition called \(runany, 3 clip\(s\)\)$/);
});

test("a failing status post is swallowed, never thrown", async () => {
  globalThis.fetch = async () => new Response("nope", { status: 500 });
  await assert.doesNotReject(status.statusOnline());
});

test("emotion timeline: two absolute GMT+7 times, three T+X offsets", () => {
  const commandAtMs = Date.UTC(2026, 8, 24, 7, 10, 0);
  const timeline = {
    uploadedAtMs: Date.UTC(2026, 8, 24, 5, 3, 11),
    commandAtMs,
    preprocessDoneS: 38.2,
    vlmDoneS: 75.9,
  };
  assert.equal(
    formatTimeline(timeline, commandAtMs + 80_300),
    [
      "**Timeline** (GMT+7)",
      "• Clip uploaded: 24/09/2026 12:03:11",
      "• Run command given: 24/09/2026 14:10:00 — T+0",
      "• Preprocess finished: T+38.2s",
      "• VLM inference finished: T+1m15.9s",
      "• Final message sent: T+1m20.3s",
    ].join("\n")
  );
  assert.match(formatTimeline({ ...timeline, resent: true }, commandAtMs + 3_600_000), /Final message sent: resent at 24\/09\/2026 15:10:00/);
});
