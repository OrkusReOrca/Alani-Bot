import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "events";

process.env.DISCORD_OWNER_0 = "100000000000000001";

const { buildListPages, truncateName, FILES_PER_PAGE, MAX_NAME_LENGTH } = await import("../src/features/voice-player/listPages.js");
const { sendPaginated, pagesAsText } = await import("../src/common/pagination.js");
const { createExecute } = await import("../src/features/voice-player/command.js");
const { makeSession } = await import("./helpers/voiceFakes.js");

const file = (name, modifiedTime) => ({ name, modifiedTime });
const manyFiles = (n) => Array.from({ length: n }, (_, i) => file(`Track ${String(i).padStart(3, "0")}.mp3`, new Date(Date.UTC(2026, 0, 1 + i)).toISOString()));

// ---------- layout ----------
test("alphabetical pages: 15 numbered files per page, case-insensitive order, footer with page and total", () => {
  const files = [file("banana.mp3", "2026-01-02T00:00:00Z"), file("Apple.mp3", "2026-01-01T00:00:00Z"), file("cherry.mp3", "2026-01-03T00:00:00Z")];
  const [page] = buildListPages(files, "a");

  assert.equal(page.title, "Files to play · A–Z");
  assert.equal(page.description, "**#1** - Apple.mp3\n**#2** - banana.mp3\n**#3** - cherry.mp3");
  assert.equal(page.footer, "Page 1 / 1 · 3 files");
});

test("newest-first pages show each file's date in GMT+7", () => {
  const files = [file("old.mp3", "2026-01-01T00:00:00Z"), file("new.mp3", "2026-09-24T20:00:00Z")]; // 20:00Z is already the 25th in GMT+7
  const [page] = buildListPages(files, "d");

  assert.equal(page.title, "Files to play · newest first");
  assert.equal(page.description, "**#1** - new.mp3 · 25/09/2026\n**#2** - old.mp3 · 01/01/2026");
});

test("many files split into pages with numbering that continues across them", () => {
  const pages = buildListPages(manyFiles(40), "a");
  assert.equal(pages.length, 3); // 15 + 15 + 10
  assert.equal(pages[0].description.split("\n").length, FILES_PER_PAGE);
  assert.equal(pages[2].description.split("\n").length, 10);
  assert.match(pages[1].description, /^\*\*#16\*\* - Track 015\.mp3/);
  assert.match(pages[2].description, /\*\*#40\*\* - Track 039\.mp3$/);
  assert.deepEqual(pages.map((p) => p.footer), ["Page 1 / 3 · 40 files", "Page 2 / 3 · 40 files", "Page 3 / 3 · 40 files"]);

  assert.match(buildListPages(manyFiles(1))[0].footer, /1 file$/); // singular
});

test("long names are cut with an ellipsis; short ones are untouched", () => {
  const long = "A very long song title that definitely goes on for far too long.mp3";
  const cut = truncateName(long);
  assert.ok(cut.length <= MAX_NAME_LENGTH);
  assert.ok(cut.endsWith("…"));
  assert.ok(!cut.endsWith(" …"), "no dangling space before the ellipsis");
  assert.equal(truncateName("Short.mp3"), "Short.mp3");
  assert.equal(truncateName("x".repeat(MAX_NAME_LENGTH)), "x".repeat(MAX_NAME_LENGTH)); // exactly at the limit: kept
});

test("an empty folder gives one explanatory page", () => {
  const pages = buildListPages([], "a");
  assert.equal(pages.length, 1);
  assert.match(pages[0].description, /No playable files found/);
});

test("the pages never mutate the input order", () => {
  const files = [file("b.mp3", "2026-01-01T00:00:00Z"), file("a.mp3", "2026-01-02T00:00:00Z")];
  buildListPages(files, "a");
  assert.deepEqual(files.map((f) => f.name), ["b.mp3", "a.mp3"]);
});

// ---------- the buttons ----------
function fakeMessage(authorId = "100000000000000001") {
  const collector = new EventEmitter();
  const sent = { edits: [], collectorOptions: null, createMessageComponentCollector: (options) => ((sent.collectorOptions = options), collector), edit: async (payload) => sent.edits.push(payload) };
  const replies = [];
  return { author: { id: authorId }, reply: async (payload) => (replies.push(payload), sent), replies, sent, collector };
}

function press(message, customId, userId) {
  const calls = { updates: [], replies: [] };
  const interaction = { customId, user: { id: userId }, update: async (p) => calls.updates.push(p), reply: async (p) => calls.replies.push(p) };
  message.collector.emit("collect", interaction);
  return new Promise((resolve) => setImmediate(() => resolve(calls)));
}

const buttonState = (row) => row.components.map((c) => ({ id: c.data.custom_id, emoji: c.data.emoji.name, disabled: Boolean(c.data.disabled) }));

test("the first page is sent with ⬅️ ➡️ buttons (back disabled), and the footer carries the page number", async () => {
  const message = fakeMessage();
  await sendPaginated(message, buildListPages(manyFiles(40), "a"));

  const [payload] = message.replies;
  assert.equal(payload.embeds[0].data.footer.text, "Page 1 / 3 · 40 files");
  assert.match(payload.embeds[0].data.description, /^\*\*#1\*\* - Track 000\.mp3/);
  assert.deepEqual(buttonState(payload.components[0]), [
    { id: "pages:previous", emoji: "⬅️", disabled: true },
    { id: "pages:next", emoji: "➡️", disabled: false },
  ]);
  assert.equal(payload.allowedMentions.repliedUser, false);
});

test("➡️ and ⬅️ turn the pages and the buttons disable at each end", async () => {
  const message = fakeMessage();
  await sendPaginated(message, buildListPages(manyFiles(40), "a"));

  const next1 = await press(message, "pages:next", message.author.id);
  assert.equal(next1.updates[0].embeds[0].data.footer.text, "Page 2 / 3 · 40 files");
  assert.deepEqual(buttonState(next1.updates[0].components[0]).map((b) => b.disabled), [false, false]);

  const next2 = await press(message, "pages:next", message.author.id);
  assert.equal(next2.updates[0].embeds[0].data.footer.text, "Page 3 / 3 · 40 files");
  assert.deepEqual(buttonState(next2.updates[0].components[0]).map((b) => b.disabled), [false, true]); // forward disabled on the last page

  const stuck = await press(message, "pages:next", message.author.id); // can't go past the end
  assert.equal(stuck.updates[0].embeds[0].data.footer.text, "Page 3 / 3 · 40 files");

  const back = await press(message, "pages:previous", message.author.id);
  assert.equal(back.updates[0].embeds[0].data.footer.text, "Page 2 / 3 · 40 files");
});

test("only the person who asked can turn the pages", async () => {
  const message = fakeMessage("100000000000000001");
  await sendPaginated(message, buildListPages(manyFiles(40), "a"));

  const stranger = await press(message, "pages:next", "999999999999999999");
  assert.equal(stranger.updates.length, 0);
  assert.match(stranger.replies[0].content, /Only the person who asked/);
  assert.equal(stranger.replies[0].ephemeral, true);

  const owner = await press(message, "pages:next", "100000000000000001");
  assert.equal(owner.updates.length, 1); // the stranger's click didn't move the page
  assert.match(owner.updates[0].embeds[0].data.footer.text, /Page 2 \/ 3/);
});

test("the buttons are removed when the list goes idle; a single page has no buttons or collector", async () => {
  const message = fakeMessage();
  await sendPaginated(message, buildListPages(manyFiles(40), "a"), { idleMs: 1234 });
  assert.equal(message.sent.collectorOptions.idle, 1234);
  message.collector.emit("end");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(message.sent.edits, [{ components: [] }]);

  const single = fakeMessage();
  await sendPaginated(single, buildListPages(manyFiles(3), "a"));
  assert.deepEqual(single.replies[0].components, []);
  assert.equal(single.sent.collectorOptions, null);
});

test("plain-text fallback shows the first page", () => {
  const text = pagesAsText(buildListPages(manyFiles(40), "a"));
  assert.match(text, /^\*\*Files to play · A–Z\*\*\n\*\*#1\*\* - Track 000\.mp3/);
  assert.match(text, /Page 1 \/ 3 · 40 files$/);
});

// ---------- the command ----------
function setup(files) {
  const world = makeSession();
  let listCalls = 0;
  const execute = createExecute({
    getSession: () => world.session,
    setTextChannel: () => {},
    prepareVoice: async () => assert.fail("listing files must not need ffmpeg"),
    findPlayableFile: async () => assert.fail("not used"),
    listPlayableFiles: async () => (listCalls++, files),
  });
  const run = async (words, { replyPages = true, guildId = "g1", user = "100000000000000009" } = {}) => {
    const out = { plain: [], pages: [] };
    const ctx = { userId: user, channelId: "t", guildId, voiceChannelId: null, reply: async (t) => out.plain.push(t) };
    if (replyPages) ctx.replyPages = async (pages) => out.pages.push(pages);
    await execute(ctx, words.split(" ").filter(Boolean));
    return out;
  };
  return { run, listCalls: () => listCalls };
}

test(".avc list defaults to A–Z, `a` and `d` pick the sort; open to anyone, no voice channel needed", async () => {
  const files = [file("b.mp3", "2026-01-01T00:00:00Z"), file("a.mp3", "2026-02-01T00:00:00Z")];
  const t = setup(files);

  const plain = await t.run("list");
  assert.equal(plain.pages[0][0].title, "Files to play · A–Z");
  assert.match(plain.pages[0][0].description, /^\*\*#1\*\* - a\.mp3/);

  assert.equal((await t.run("list a")).pages[0][0].title, "Files to play · A–Z");
  const byDate = await t.run("list d");
  assert.equal(byDate.pages[0][0].title, "Files to play · newest first");
  assert.match(byDate.pages[0][0].description, /^\*\*#1\*\* - a\.mp3 · 01\/02\/2026/); // a.mp3 is newer
  assert.equal((await t.run("LIST D")).pages.length, 1);
});

test(".avc list rejects other sorts, reports a Drive failure, and falls back to text without buttons support", async () => {
  const t = setup([file("a.mp3", "2026-01-01T00:00:00Z")]);
  assert.match((await t.run("list z")).plain[0], /Usage: `\.avc list`/);
  assert.equal(t.listCalls(), 0); // a bad argument doesn't hit Drive

  const text = await t.run("list", { replyPages: false });
  assert.equal(text.pages.length, 0);
  assert.match(text.plain[0], /\*\*#1\*\* - a\.mp3/);

  const broken = createExecute({ getSession: () => makeSession().session, setTextChannel: () => {}, prepareVoice: async () => {}, findPlayableFile: async () => {}, listPlayableFiles: async () => { throw new Error("Drive folder not found"); } });
  const replies = [];
  await broken({ userId: "u", channelId: "c", guildId: "g", reply: async (t2) => replies.push(t2) }, ["list"]);
  assert.match(replies[0], /Couldn't read the file list: Drive folder not found/);
});
