import { test } from "node:test";
import assert from "node:assert/strict";
import { createDiscordStore } from "../src/features/cloud-backup/discordStore.js";
import { generateKeyHex, parseKey, CorruptBackupError } from "../src/features/cloud-backup/crypto.js";

const BOT_ID = "900";
const CHANNEL = "555";

// A tiny in-memory Discord: one channel, plus the CDN the attachments live on.
function installFakeDiscord() {
  const messages = []; // oldest first
  const blobs = new Map(); // cdn url -> Buffer
  let nextId = 1000;

  const asMessage = (m) => ({ id: m.id, content: m.content, author: { id: m.authorId }, attachments: m.attachments });
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

  globalThis.fetch = async (url, options = {}) => {
    const { pathname, searchParams } = new URL(url);
    const method = options.method ?? "GET";

    if (pathname.startsWith("/cdn/")) return blobs.has(url) ? new Response(blobs.get(url)) : new Response("gone", { status: 404 });
    if (pathname === "/api/v10/users/@me") return json({ id: BOT_ID });

    if (pathname === `/api/v10/channels/${CHANNEL}/messages` && method === "POST") {
      const form = options.body;
      const id = String(nextId++);
      const attachments = [];
      for (const [field, value] of form.entries()) {
        if (!field.startsWith("files[")) continue;
        const cdnUrl = `https://discord.test/cdn/${id}/${attachments.length}`;
        blobs.set(cdnUrl, Buffer.from(await value.arrayBuffer()));
        attachments.push({ filename: value.name, url: cdnUrl });
      }
      const message = { id, content: JSON.parse(form.get("payload_json")).content, authorId: BOT_ID, attachments };
      messages.push(message);
      return json(asMessage(message));
    }

    if (pathname === `/api/v10/channels/${CHANNEL}/messages` && method === "GET") {
      const limit = Number(searchParams.get("limit"));
      const before = searchParams.get("before");
      const newestFirst = [...messages].reverse().filter((m) => !before || BigInt(m.id) < BigInt(before));
      return json(newestFirst.slice(0, limit).map(asMessage));
    }

    const single = pathname.match(new RegExp(`/api/v10/channels/${CHANNEL}/messages/(\\d+)$`));
    if (single && method === "GET") return json(asMessage(messages.find((m) => m.id === single[1])));
    if (single && method === "DELETE") {
      messages.splice(messages.findIndex((m) => m.id === single[1]), 1);
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected request ${method} ${url}`);
  };

  return {
    messages,
    // Someone other than the bot posting in the channel.
    postAsStranger: (content) => messages.push({ id: String(nextId++), content, authorId: "123", attachments: [] }),
  };
}

const makeStore = () => createDiscordStore({ botToken: "t", channelId: CHANNEL, key: parseKey(generateKeyHex()) });
const bytes = (text) => Buffer.from(text);

test("put stores one message per instance with encrypted attachments; get decrypts them back", async () => {
  const discord = installFakeDiscord();
  const store = makeStore();

  await store.put("db", "instance_00001__2026", { "db-core.db": bytes("core data"), "orkus-info.db": bytes("orkus data") });

  assert.equal(discord.messages.length, 1);
  assert.equal(discord.messages[0].content, "alani-backup db instance_00001__2026");
  assert.deepEqual(discord.messages[0].attachments.map((a) => a.filename), ["db-core.db.enc", "orkus-info.db.enc"]);

  const [item] = await store.list("db");
  assert.deepEqual(await store.get(item), { "db-core.db": bytes("core data"), "orkus-info.db": bytes("orkus data") });
});

test("list is per group, oldest first, ignores strangers' messages, and pages past 100", async () => {
  const discord = installFakeDiscord();
  const store = makeStore();

  await store.put("db", "instance_00001__a", { "x.db": bytes("1") });
  await store.put("settings", "instance_00001__a", { "y.db": bytes("2") });
  for (let i = 0; i < 120; i++) discord.postAsStranger("chatter");
  discord.postAsStranger("alani-backup db instance_00099__fake");
  await store.put("db", "instance_00002__b", { "x.db": bytes("3") });

  assert.deepEqual((await store.list("db")).map((i) => i.name), ["instance_00001__a", "instance_00002__b"]);
  assert.deepEqual((await store.list("settings")).map((i) => i.name), ["instance_00001__a"]);
});

test("a tampered attachment, or a wrong key, surfaces as CorruptBackupError", async () => {
  const discord = installFakeDiscord();
  const store = makeStore();
  await store.put("db", "instance_00001__a", { "x.db": bytes("secret") });
  const [item] = await store.list("db");

  const otherKeyStore = makeStore();
  await assert.rejects(otherKeyStore.get(item), CorruptBackupError);

  const url = discord.messages[0].attachments[0].url;
  const blob = Buffer.from(await (await fetch(url)).arrayBuffer());
  blob[blob.length - 1] ^= 1;
  // Swap the tampered bytes in behind the same URL.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, o) => (String(u) === url ? new Response(blob) : realFetch(u, o));
  await assert.rejects(store.get(item), CorruptBackupError);
});

test("an attachment that can't be downloaded is a plain error, not corruption", async () => {
  installFakeDiscord();
  const store = makeStore();
  await store.put("db", "instance_00001__a", { "x.db": bytes("data") });
  const [item] = await store.list("db");

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, o) => (String(u).includes("/cdn/") ? new Response("nope", { status: 503 }) : realFetch(u, o));
  await assert.rejects(store.get(item), (err) => !(err instanceof CorruptBackupError) && /503/.test(err.message));
});

test("remove deletes the message", async () => {
  const discord = installFakeDiscord();
  const store = makeStore();
  await store.put("db", "instance_00001__a", { "x.db": bytes("1") });
  const [item] = await store.list("db");

  await store.remove(item);
  assert.equal(discord.messages.length, 0);
});
