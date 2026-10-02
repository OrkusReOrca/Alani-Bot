import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DISCORD_OWNER_0 = "100000000000000001";

const { parseQuotedNames, matchByName } = await import("../src/features/voice-player/match.js");
const { createExecute } = await import("../src/features/voice-player/command.js");
const { buildFileListText } = await import("../src/features/voice-player/listPages.js");
const { runAssistant } = await import("../src/features/ai-assistant/assistant.js");
const { makeSession } = await import("./helpers/voiceFakes.js");

const OWNER = "100000000000000001";
const NAMES = ["Robin - Alpha.mp3", "Robin - Beta.mp3", "Robin - Gamma.mp3", "Other Artist - Song.mp3", "Rainbow Road.mp3", "Rain Sounds.mp3"];
const FILES = NAMES.map((name) => ({ id: `id-${name}`, name, mimeType: "audio/mpeg", modifiedTime: "2026-01-01T00:00:00Z" }));

// ---------- parsing ----------
test("quoted names are parsed with or without spaces between them; anything else isn't a multi list", () => {
  assert.deepEqual(parseQuotedNames('"A.mp3" "B.mp3"'), ["A.mp3", "B.mp3"]);
  assert.deepEqual(parseQuotedNames('"A.mp3""B.mp3""C"'), ["A.mp3", "B.mp3", "C"]);
  assert.deepEqual(parseQuotedNames('  "My Song - Live.mp3"   "B" '), ["My Song - Live.mp3", "B"]);
  assert.deepEqual(parseQuotedNames("“Curly A.mp3” “Curly B.mp3”"), ["Curly A.mp3", "Curly B.mp3"]); // phone keyboards
  assert.deepEqual(parseQuotedNames('"one"'), ["one"]);
  assert.deepEqual(parseQuotedNames('"" "x"'), ["x"]); // empty names dropped

  assert.equal(parseQuotedNames("plain name"), null);
  assert.equal(parseQuotedNames('"quoted" and plain'), null);
  assert.equal(parseQuotedNames('plain "quoted"'), null);
  assert.equal(parseQuotedNames(""), null);
});

// ---------- the command ----------
function setup() {
  const world = makeSession();
  const execute = createExecute({
    getSession: () => world.session,
    setTextChannel: () => {},
    prepareVoice: async () => {},
    findPlayableFile: async (query) => matchByName(FILES, query, (f) => f.name),
    listPlayableFiles: async () => FILES,
  });
  const run = async (line, { user = OWNER, vc = "vc1" } = {}) => {
    const replies = [];
    await execute({ userId: user, channelId: "t", guildId: "g1", voiceChannelId: vc, reply: async (t) => replies.push(t) }, line.split(/\s+/).filter(Boolean));
    return replies.join("\n");
  };
  return { ...world, run };
}

test("play with several quoted names queues them all, in order, and starts the first", async () => {
  const t = setup();
  const reply = await t.run('play "Robin - Beta.mp3" "Robin - Alpha.mp3" "Rain Sounds.mp3"');

  assert.match(reply, /Playing \*\*Robin - Beta\.mp3\*\* and queued 2 more\./);
  assert.deepEqual(t.names(), ["Robin - Beta.mp3", "Robin - Alpha.mp3", "Rain Sounds.mp3"]);
  assert.equal(t.cache.opened[0], "Robin - Beta.mp3");
  assert.equal(t.session.channelId(), "vc1"); // joined once, for the whole batch
  assert.equal(t.output.log.filter((l) => l.startsWith("join")).length, 1);
});

test("names glued together without spaces work, and the short form p works", async () => {
  const t = setup();
  await t.run('p "Robin - Alpha.mp3""Robin - Beta.mp3"');
  assert.deepEqual(t.names(), ["Robin - Alpha.mp3", "Robin - Beta.mp3"]);
});

test("added behind existing tracks: reports the queue positions", async () => {
  const t = setup();
  await t.run('play "Rain Sounds.mp3"');
  const reply = await t.run('play "Robin - Alpha.mp3" "Robin - Beta.mp3"');
  assert.match(reply, /Added 2 songs to the queue \(positions 2–3\)\./);
  assert.deepEqual(t.names(), ["Rain Sounds.mp3", "Robin - Alpha.mp3", "Robin - Beta.mp3"]);
});

test("files that aren't found or are ambiguous are reported and skipped; the rest are still added", async () => {
  const t = setup();
  const reply = await t.run('play "Robin - Alpha.mp3" "No Such Song.mp3" "rain" "Robin - Gamma.mp3"');

  assert.match(reply, /Playing \*\*Robin - Alpha\.mp3\*\* and queued 1 more/);
  assert.match(reply, /Couldn't add 2: "No Such Song\.mp3" \(no such file\), "rain" \(matches several files: Rainbow Road\.mp3, Rain Sounds\.mp3…\)/);
  assert.deepEqual(t.names(), ["Robin - Alpha.mp3", "Robin - Gamma.mp3"]);
});

test("if none are found nothing is queued and the bot doesn't even join", async () => {
  const t = setup();
  assert.match(await t.run('play "Nope 1" "Nope 2"'), /None of those files were found\.\nCouldn't add 2/);
  assert.deepEqual(t.names(), []);
  assert.equal(t.session.isConnected(), false);
});

test("not in a voice channel: refused without queueing anything", async () => {
  const t = setup();
  assert.match(await t.run('play "Robin - Alpha.mp3" "Robin - Beta.mp3"', { vc: null }), /Join a voice channel first/);
  assert.deepEqual(t.names(), []);
});

test("a single quoted name still works as before, and force play takes one file only", async () => {
  const t = setup();
  assert.match(await t.run('play "Rain Sounds.mp3"'), /Playing \*\*Rain Sounds\.mp3\*\*/);
  assert.match(await t.run('force play "Robin - Alpha.mp3" "Robin - Beta.mp3"'), /takes one file at a time/);
  assert.match(await t.run('force play "Robin - Alpha.mp3"'), /Playing \*\*Robin - Alpha\.mp3\*\* next/);
});

test("too many songs in one command is refused; long failure lists are shortened", async () => {
  const t = setup();
  const tooMany = Array.from({ length: 41 }, (_, i) => `"s${i}"`).join(" ");
  assert.match(await t.run(`play ${tooMany}`), /That's 41 songs — add at most 40/);

  const manyMissing = Array.from({ length: 12 }, (_, i) => `"missing${i}"`).join(" ") + ' "Rain Sounds.mp3"';
  const reply = await t.run(`play ${manyMissing}`);
  assert.match(reply, /Couldn't add 12:/);
  assert.match(reply, /…and 4 more/);
  assert.ok(reply.length < 2000, "the reply must fit in one Discord message");
});

// ---------- .aii: it can read the list and queue the matches ----------
test(".avc list gives .aii the complete, untruncated names, and a multi-song play does the rest", async () => {
  const t = setup();
  const longName = "Robin - A Really Quite Extraordinarily Long Song Title That Gets Cut In The Box.mp3";
  FILES.push({ id: "id-long", name: longName, mimeType: "audio/mpeg", modifiedTime: "2026-02-01T00:00:00Z" });

  const posted = [];
  const env = { user: { id: OWNER }, channelId: "t", guildId: "g1", voiceChannelId: "vc1", post: async (x) => posted.push(x), postFile: async () => {}, postPages: async (pages) => posted.push(`[pages: ${pages.length}]`), confirm: async () => true };
  const toolCall = (id, command) => ({ id, type: "function", function: { name: "run_command", arguments: JSON.stringify({ command }) } });
  const toolResults = [];
  const llm = {
    chat: async (messages) => {
      const results = messages.filter((m) => m.role === "tool");
      toolResults.push(...results.slice(toolResults.length).map((m) => m.content));
      if (results.length === 0) return { message: { role: "assistant", content: null, tool_calls: [toolCall("1", ".avc list")] }, usage: {} };
      if (results.length === 1) {
        // The model "reads" the list and picks every Robin song.
        const robin = results[0].content.split("\n").filter((l) => l.startsWith("- Robin")).map((l) => `"${l.slice(2)}"`);
        return { message: { role: "assistant", content: null, tool_calls: [toolCall("2", `.avc play ${robin.join(" ")}`)] }, usage: {} };
      }
      return { message: { role: "assistant", content: "" }, usage: {} };
    },
  };
  const history = { startCall: () => 1, recordEvent: () => {}, finishCall: () => {} };
  const commands = new Map([["avc", { data: { name: "avc" }, aiGuide: "x", execute: createExecute({ getSession: () => t.session, setTextChannel: () => {}, prepareVoice: async () => {}, findPlayableFile: async (q) => matchByName(FILES, q, (f) => f.name), listPlayableFiles: async () => FILES }) }]]);

  await runAssistant({ text: "add all song by robin into the queue", systemPrompt: "SYS", memory: [], env, commands, llm, history, model: "m" });

  assert.ok(toolResults[0].includes(longName), "the model must see the full name, not the 40-character cut");
  assert.match(toolResults[0], new RegExp(`^${FILES.length} playable files \\(A–Z\\):\\n- `));
  assert.deepEqual(t.names().sort(), ["Robin - Alpha.mp3", "Robin - Beta.mp3", "Robin - Gamma.mp3", longName].sort());
  assert.equal(t.names().includes("Other Artist - Song.mp3"), false);
  assert.ok(posted.includes("[pages: 1]")); // the user still sees the paged list
  FILES.pop();
});

test("the list text for the model is complete and sorted like the pages", () => {
  const text = buildFileListText([{ name: "b.mp3", modifiedTime: "2026-01-01T00:00:00Z" }, { name: "A.mp3", modifiedTime: "2026-02-01T00:00:00Z" }], "a");
  assert.equal(text, "2 playable files (A–Z):\n- A.mp3\n- b.mp3");
  assert.equal(buildFileListText([{ name: "x.mp3", modifiedTime: "2026-01-01T00:00:00Z" }], "d"), "1 playable file (newest first):\n- x.mp3");
});
