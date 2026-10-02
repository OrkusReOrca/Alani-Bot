import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "events";

process.env.DISCORD_OWNER_0 = "100000000000000001";

const { parseSongName, groupByMedia } = await import("../src/features/voice-player/mediaGroups.js");
const { buildListPages, buildFileListText } = await import("../src/features/voice-player/listPages.js");
const { sendPaginated, pagesAsText } = await import("../src/common/pagination.js");
const { createExecute } = await import("../src/features/voice-player/command.js");
const { makeSession } = await import("./helpers/voiceFakes.js");

const f = (name) => ({ name, modifiedTime: "2026-01-01T00:00:00Z" });
const LIBRARY = [
  "Hoyomix-Genshin-Ronova Boss Fight Theme.mp4",
  "Hoyomix-Genshin-Liyue Harbor.mp3",
  "Yu-Peng Chau-Genshin-Not Used.mp3", // an artist containing a dash shifts the fields (media parses as "Peng Chau", alone) -> Others
  "Miku-Monitoring (Best Friend Remix).m4a", // no media part
  "Hoyomix-Honkai Star Rail-Jarilo-VI.mp3",
  "Hoyomix-Honkai Star Rail-Stellaron Hunters.mp3",
  "Hoyomix-Honkai Star Rail-Dan Heng.mp3",
  "Toby Fox-Undertale-Megalovania.mp3", // the only Undertale song -> Others
  "Daft Punk-One More Time.flac", // no media part
  "ado-Genshin-Song with - dash - inside.opus",
].map(f);

// ---------- parsing ----------
test("a name is split on its first two dashes only, so the song title may contain dashes", () => {
  assert.deepEqual(parseSongName("Hoyomix-Genshin-Ronova Boss Fight Theme.mp4"), { artist: "Hoyomix", media: "Genshin", song: "Ronova Boss Fight Theme" });
  assert.deepEqual(parseSongName("ado-Genshin-Song with - dash - inside.opus"), { artist: "ado", media: "Genshin", song: "Song with - dash - inside" });
  assert.deepEqual(parseSongName("Hoyomix - Genshin - Spaced Dashes.mp3"), { artist: "Hoyomix", media: "Genshin", song: "Spaced Dashes" });
  assert.deepEqual(parseSongName("Miku-Monitoring (Best Friend Remix).m4a"), { artist: "Miku", media: null, song: "Monitoring (Best Friend Remix)" });
  assert.deepEqual(parseSongName("JustAName.mp3"), { artist: "JustAName", media: null, song: "" });
});

// ---------- grouping ----------
test("groups need two songs; singles and media-less names go to Others; everything sorted", () => {
  const { groups, others } = groupByMedia(LIBRARY);

  assert.deepEqual(groups.map((g) => g.media), ["Genshin", "Honkai Star Rail"]);
  assert.deepEqual(groups[0].files.map((x) => x.name), [
    "ado-Genshin-Song with - dash - inside.opus",
    "Hoyomix-Genshin-Liyue Harbor.mp3",
    "Hoyomix-Genshin-Ronova Boss Fight Theme.mp4",
  ]);
  assert.deepEqual(groups[1].files.map((x) => x.name), ["Hoyomix-Honkai Star Rail-Dan Heng.mp3", "Hoyomix-Honkai Star Rail-Jarilo-VI.mp3", "Hoyomix-Honkai Star Rail-Stellaron Hunters.mp3"]);
  assert.deepEqual(others.map((x) => x.name), ["Daft Punk-One More Time.flac", "Miku-Monitoring (Best Friend Remix).m4a", "Toby Fox-Undertale-Megalovania.mp3", "Yu-Peng Chau-Genshin-Not Used.mp3"]);
});

test("media names match case-insensitively and keep the first spelling; media sort alphabetically", () => {
  const { groups } = groupByMedia([f("A-genshin-One.mp3"), f("B-Genshin-Two.mp3"), f("C-Apex-One.mp3"), f("D-APEX-Two.mp3"), f("E-Zelda-One.mp3"), f("F-Zelda-Two.mp3")]);
  assert.deepEqual(groups.map((g) => g.media), ["Apex", "genshin", "Zelda"]);
  assert.equal(groups[1].files.length, 2);
});

test("nothing but media-less names: no groups, everything in Others", () => {
  const { groups, others } = groupByMedia([f("b-Song.mp3"), f("a-Song.mp3")]);
  assert.equal(groups.length, 0);
  assert.deepEqual(others.map((x) => x.name), ["a-Song.mp3", "b-Song.mp3"]);
});

// ---------- the columns ----------
test("each media group is an inline column, with Others last, and the footer counts files and groups", () => {
  const pages = buildListPages(LIBRARY, "m");
  assert.equal(pages.length, 1);
  const [page] = pages;

  assert.equal(page.title, "Files to play · by media");
  assert.deepEqual(page.fields.map((x) => x.name), ["Genshin", "Honkai Star Rail", "Others"]);
  assert.equal(page.fields[0].value, "ado - Song with - dash - inside\nHoyomix - Liyue Harbor\nHoyomix - Ronova Boss Fight Theme");
  assert.equal(page.fields[1].value, "Hoyomix - Dan Heng\nHoyomix - Jarilo-VI\nHoyomix - Stellaron Hunters");
  // Others show full names (their media was lost), extension removed.
  assert.equal(page.fields[2].value, "Daft Punk-One More Time\nMiku-Monitoring (Best Friend Remix)\nToby Fox-Undertale-Megalovania\nYu-Peng Chau-Genshin-Not Used");
  assert.equal(page.footer, "Page 1 / 1 · 10 files · 2 media groups");
  assert.equal(page.description, undefined);
});

test("with no Others there's no Others column; with no groups there's only Others", () => {
  const onlyGroups = buildListPages([f("a-Game-One.mp3"), f("b-Game-Two.mp3")], "m")[0];
  assert.deepEqual(onlyGroups.fields.map((x) => x.name), ["Game"]);
  const onlyOthers = buildListPages([f("a-One.mp3")], "m")[0];
  assert.deepEqual(onlyOthers.fields.map((x) => x.name), ["Others"]);
  assert.match(buildListPages([], "m")[0].description, /No playable files found/);
});

test("many groups are spread over pages of 9 columns (3 x 3), Others staying last", () => {
  const files = [];
  for (let g = 0; g < 12; g++) for (const n of ["One", "Two"]) files.push(f(`Artist-Game ${String(g).padStart(2, "0")}-${n}.mp3`));
  files.push(f("Loner-Single.mp3"));

  const pages = buildListPages(files, "m");
  assert.deepEqual(pages.map((p) => p.fields.length), [9, 4]); // 12 groups + Others = 13 columns
  assert.equal(pages[0].fields[0].name, "Game 00");
  assert.equal(pages[1].fields.at(-1).name, "Others");
  assert.deepEqual(pages.map((p) => p.footer.split(" · ")[0]), ["Page 1 / 2", "Page 2 / 2"]);
});

test("a huge group continues in further columns, every column within Discord's limits", () => {
  const files = Array.from({ length: 40 }, (_, i) => f(`Artist-Big Game-Song number ${String(i).padStart(2, "0")} with a longish title here.mp3`));
  const pages = buildListPages(files, "m");
  const fields = pages.flatMap((p) => p.fields);

  assert.deepEqual(fields.map((x) => x.name), ["Big Game", "Big Game (2)", "Big Game (3)"]); // 15 + 15 + 10
  for (const field of fields) {
    assert.ok(field.value.length <= 1024, `field ${field.name} is ${field.value.length} chars`);
    assert.ok(field.value.split("\n").length <= 15);
  }
  for (const page of pages) assert.ok(page.fields.reduce((n, x) => n + x.name.length + x.value.length, 0) < 6000);
});

test("long song lines are cut so a column stays readable", () => {
  const long = "Artist-Game-" + "A very long song title ".repeat(6) + ".mp3";
  const [page] = buildListPages([f(long), f("B-Game-Short.mp3")], "m");
  const line = page.fields[0].value.split("\n")[0];
  assert.ok(line.length <= 40);
  assert.ok(line.endsWith("…"));
});

// ---------- how it reaches Discord, and the model ----------
test("the embed carries the columns as inline fields; the plain-text fallback lists them", async () => {
  const sentPayloads = [];
  const message = { author: { id: "u" }, reply: async (p) => (sentPayloads.push(p), { createMessageComponentCollector: () => new EventEmitter(), edit: async () => {} }) };
  const pages = buildListPages(LIBRARY, "m");
  await sendPaginated(message, pages);

  const embed = sentPayloads[0].embeds[0].data;
  assert.deepEqual(embed.fields.map((x) => [x.name, x.inline]), [["Genshin", true], ["Honkai Star Rail", true], ["Others", true]]);
  assert.deepEqual(sentPayloads[0].components, []); // one page: no buttons

  assert.match(pagesAsText(pages), /^\*\*Files to play · by media\*\*\n\*\*Genshin\*\*\nado - Song with - dash - inside/);
  assert.match(pagesAsText(pages), /\*\*Others\*\*\nDaft Punk-One More Time/);
});

test("the text for .aii groups the FULL file names under their media", () => {
  const text = buildFileListText(LIBRARY, "m");
  assert.match(text, /^10 playable files \(by media\):\n## Genshin\n- ado-Genshin-Song with - dash - inside\.opus\n- Hoyomix-Genshin-Liyue Harbor\.mp3/);
  assert.match(text, /## Honkai Star Rail\n- Hoyomix-Honkai Star Rail-Dan Heng\.mp3/);
  assert.match(text, /## Others\n- Daft Punk-One More Time\.flac\n- Miku-Monitoring \(Best Friend Remix\)\.m4a/);
});

test(".avc list m (and the short form l m) shows the media view; unknown sorts show usage including m", async () => {
  const world = makeSession();
  const execute = createExecute({ getSession: () => world.session, setTextChannel: () => {}, prepareVoice: async () => {}, findPlayableFile: async () => {}, listPlayableFiles: async () => LIBRARY });
  const run = async (words) => {
    const out = { pages: [], plain: [], detail: [] };
    await execute(
      { userId: "100000000000000009", channelId: "c", guildId: "g", voiceChannelId: null, reply: async (t) => out.plain.push(t), replyPages: async (p, o) => (out.pages.push(p), out.detail.push(o?.detail)) },
      words.split(" ")
    );
    return out;
  };

  const full = await run("list m");
  assert.equal(full.pages[0][0].title, "Files to play · by media");
  assert.match(full.detail[0], /^10 playable files \(by media\):\n## Genshin/);
  assert.equal((await run("l m")).pages[0][0].title, "Files to play · by media");
  assert.equal((await run("ls M")).pages[0][0].title, "Files to play · by media");
  assert.match((await run("list z")).plain[0], /list m/);
});
