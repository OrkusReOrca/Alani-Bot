import { test, after } from "node:test";
import assert from "node:assert/strict";

process.env.DISCORD_OWNER_0 = "900000000000000001";
const OWNER = "900000000000000001";
const DEV = "800000000000000001"; // tier1dev
const PR = "800000000000000002"; // tierPRdev
const NOBODY = "800000000000000003";
const CHANNEL = "1560629482182803456";

const { parseApprove, parseCreate, parseDelete, CREATE_USAGE } = await import("../src/features/blog/parse.js");
const { createExecute } = await import("../src/features/blog/command.js");
const { addTag, removeTag } = await import("../src/features/tags/store.js");
const { parseCommandLine } = await import("../src/common/commandParsing.js");

addTag(DEV, "tier1dev", OWNER);
addTag(PR, "tierPRdev", OWNER);
after(() => {
  removeTag(DEV, "tier1dev");
  removeTag(PR, "tierPRdev");
});

const POST = '.ad blog create alani.webapp title:"Music in step" by:"Higgorca" "First line.\n\nSecond paragraph."';

test("parsing keeps the post's line breaks; title and by in either order; approve and delete", () => {
  assert.deepEqual(parseCommandLine(".ad blog create x"), { name: "ad", args: ["blog", "create", "x"] });
  assert.deepEqual(parseCreate(POST), { section: "alani.webapp", title: "Music in step", author: "Higgorca", body: "First line.\n\nSecond paragraph." });
  assert.deepEqual(parseCreate('.ad blog create Alani.Webapp by:"Me" title:"T" text without quotes'), { section: "alani.webapp", title: "T", author: "Me", body: "text without quotes" });
  for (const bad of [".ad blog create", '.ad blog create alani title:"T" by:"B" "x"', '.ad blog create alani.webapp title:"T" "x"', '.ad blog create alani.webapp title:"T" by:"B" ""']) {
    assert.equal(parseCreate(bad).usage, CREATE_USAGE, bad);
  }
  assert.deepEqual(parseApprove(".ad blog approve latest yes"), { which: "latest", approve: true });
  assert.deepEqual(parseApprove('.ad blog approve name:"Music in step" no'), { title: "Music in step", approve: false });
  assert.ok(parseApprove(".ad blog approve latest maybe").usage);
  assert.deepEqual(parseDelete('.ad blog delete name:"Old post"'), { title: "Old post" });
});

// A stand-in for the website's blog API, and a Discord message.
function world({ confirm = true } = {}) {
  const posts = [];
  const client = {
    isConfigured: () => true,
    async createBlogPost(post) {
      const saved = { ...post, path: `/blog/alani/webapp/${post.title.toLowerCase().replace(/\W+/g, "-")}`, images: post.images.map((_, i) => ({ src: `/blog/images/1-${i + 1}.png` })) };
      posts.push(saved);
      return { ok: true, data: { post: saved } };
    },
    async decideBlogPost(d) {
      const post = d.which === "latest" ? posts.filter((p) => p.status === "pending").at(-1) : posts.find((p) => p.status === "pending" && p.title.toLowerCase() === d.title.toLowerCase());
      if (!post) return { ok: false, data: { error: "No post is waiting for approval." } };
      post.status = d.approve ? "published" : "rejected";
      return { ok: true, data: { post } };
    },
    async deleteBlogPost(title) {
      const i = posts.findIndex((p) => p.title === title);
      return i < 0 ? { ok: false, data: { error: `No published post called "${title}".` } } : { ok: true, data: { post: posts.splice(i, 1)[0] } };
    },
    pendingBlogPosts: async () => posts.filter((p) => p.status === "pending"),
  };
  const downloads = [];
  const fetchImpl = async (url) => (downloads.push(url), { ok: true, arrayBuffer: async () => new TextEncoder().encode(`image from ${url}`).buffer });
  const execute = createExecute({ client, fetchImpl, blogChannel: CHANNEL });
  const send = async (userId, content, { attachments = [], channelId = CHANNEL } = {}) => {
    const replies = [];
    const prompts = [];
    const ctx = { userId, channelId, content, attachments, reply: async (t) => replies.push(t), confirm: async (p) => (prompts.push(p), confirm) };
    await execute(ctx, parseCommandLine(content).args);
    return { text: replies.join("\n"), prompt: prompts[0] ?? null };
  };
  return { posts, downloads, send };
}

const image = (name, size = 1000, contentType = "image/png") => ({ url: `https://cdn.discordapp.test/${name}`, name, contentType, size });

test("an owner or tier1dev publishes straight away, after confirming; images come along", async () => {
  const w = world();
  const sent = await w.send(DEV, POST, { attachments: [image("a.png"), image("b.jpg", 1000, "image/jpeg"), image("notes.txt", 10, "text/plain")] });
  assert.match(sent.prompt, /^\*\*Publish this post\?\*\*/);
  assert.match(sent.prompt, /\*\*Title:\*\* Music in step · \*\*By:\*\* Higgorca · \*\*Images:\*\* 2/);
  assert.match(sent.prompt, /left out/); // the text file
  assert.match(sent.text, /^Published: \*\*Music in step\*\*\nhttps:\/\/alatomy\.com\/blog\/alani\/webapp\/music-in-step$/);
  assert.deepEqual([w.posts[0].status, w.posts[0].submittedBy, w.posts[0].images.length, w.posts[0].body], ["published", DEV, 2, "First line.\n\nSecond paragraph."]);
  assert.deepEqual(w.downloads, ["https://cdn.discordapp.test/a.png", "https://cdn.discordapp.test/b.jpg"]);
  assert.match((await world().send(OWNER, POST)).text, /^Published/);
});

test("saying no cancels; wrong channel, no tag, too many or too big images are refused", async () => {
  assert.equal((await world({ confirm: false }).send(DEV, POST)).text, "Cancelled: nothing was posted.");
  assert.equal((await world().send(DEV, POST, { channelId: "1" })).text, `Use the blog commands in <#${CHANNEL}>.`);
  assert.equal((await world().send(NOBODY, POST)).text, "Posting to the blog needs the tier1dev or tierPRdev tag.");
  assert.match((await world().send(DEV, POST, { attachments: Array.from({ length: 11 }, (_, i) => image(`${i}.png`)) })).text, /At most 10 images/);
  assert.match((await world().send(DEV, POST, { attachments: [image("huge.png", 9 * 1024 * 1024)] })).text, /larger than 8 MB/);
  assert.match((await world().send(DEV, ".ad blog create nonsense")).text, /^Usage: `\.ad blog create/);
  assert.match((await world().send(DEV, ".ad something")).text, /^Usage:/);
});

test("tierPRdev posts wait for the owner, who approves or rejects them (latest or by name); the writer is told", async () => {
  const w = world();
  const sent = await w.send(PR, POST);
  assert.match(sent.prompt, /^\*\*Send this post for approval\?\*\*/);
  assert.match(sent.text, new RegExp(`^<@${OWNER}> \\*\\*Blog post waiting for your approval:\\*\\* "Music in step" by Higgorca .* sent by <@${PR}>`));
  assert.equal(w.posts[0].status, "pending");
  await w.send(PR, POST.replace("Music in step", "Second one"));
  assert.match((await w.send(OWNER, ".ad blog pending")).text, /"Music in step" by Higgorca[\s\S]*"Second one"/);

  assert.equal((await w.send(PR, ".ad blog approve latest yes")).text, "Only a bot owner can approve blog posts.");
  assert.match((await w.send(OWNER, ".ad blog approve latest no")).text, new RegExp(`^Rejected: \\*\\*Second one\\*\\* <@${PR}>`));
  assert.match((await w.send(OWNER, '.ad blog approve name:"music in step" yes')).text, new RegExp(`^Approved and published: \\*\\*Music in step\\*\\* <@${PR}>\\nhttps://alatomy\\.com/blog/`));
  assert.equal((await w.send(OWNER, ".ad blog approve latest yes")).text, "No post is waiting for approval.");
  assert.equal((await w.send(OWNER, ".ad blog pending")).text, "No blog posts are waiting for approval.");
});

test("an owner can delete a post, after confirming", async () => {
  const w = world();
  await w.send(OWNER, POST);
  assert.equal((await w.send(DEV, '.ad blog delete name:"Music in step"')).text, "Only a bot owner can delete blog posts.");
  assert.equal((await world({ confirm: false }).send(OWNER, '.ad blog delete name:"Music in step"')).text, "Cancelled: nothing was deleted.");
  assert.equal((await w.send(OWNER, '.ad blog delete name:"Music in step"')).text, "Deleted: **Music in step**.");
  assert.equal(w.posts.length, 0);
});
