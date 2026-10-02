import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";

// A real (throwaway) RSA key so the service-account JWT can be signed.
const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
process.env.GOOGLE_SERVICE_ACCOUNT_KEY = JSON.stringify({ client_email: "bot@example.iam.gserviceaccount.com", private_key: privateKey });

const drive = await import("../src/common/googleDrive.js");

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

// Replaces fetch with a router; records Drive calls (everything but the token request).
function fakeGoogle(routes) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(url);
    if (u.hostname === "oauth2.googleapis.com") return json({ access_token: "token-123", expires_in: 3600 });
    calls.push({ url: u, headers: options.headers });
    const handler = routes.shift();
    assert.ok(handler, `unexpected extra request: ${url}`);
    return handler(u);
  };
  return calls;
}

test("resolveFolderPath: the first folder is found among those shared with the bot, the rest inside it", async () => {
  const calls = fakeGoogle([() => json({ files: [{ id: "alani-id", name: "Alani" }] }), () => json({ files: [{ id: "vc-id", name: "Files to play discord VC" }] })]);

  assert.equal(await drive.resolveFolderPath(["Alani", "Files to play discord VC"]), "vc-id");

  const [first, second] = calls.map((c) => c.url.searchParams.get("q"));
  assert.match(first, /name = 'Alani'.*sharedWithMe = true/);
  assert.match(second, /name = 'Files to play discord VC'.*'alani-id' in parents/);
  assert.equal(calls[0].headers.Authorization, "Bearer token-123");
});

test("a missing folder fails with a message that says what to check", async () => {
  fakeGoogle([() => json({ files: [] })]);
  await assert.rejects(drive.resolveFolderPath(["Nope"]), /"Nope" not found.*shared with the bot's service account/);
});

test("names with quotes are escaped in the query", async () => {
  const calls = fakeGoogle([() => json({ files: [{ id: "x", name: "It's" }] })]);
  await drive.resolveFolderPath(["It's"]);
  assert.match(calls[0].url.searchParams.get("q"), /name = 'It\\'s'/);
});

test("listFiles returns files (not folders) and follows pagination", async () => {
  const calls = fakeGoogle([
    () => json({ files: [{ id: "1", name: "a.mp3" }], nextPageToken: "page2" }),
    (u) => {
      assert.equal(u.searchParams.get("pageToken"), "page2");
      return json({ files: [{ id: "2", name: "b.mp3" }] });
    },
  ]);

  assert.deepEqual((await drive.listFiles("folder-id")).map((f) => f.name), ["a.mp3", "b.mp3"]);
  assert.match(calls[0].url.searchParams.get("q"), /'folder-id' in parents.*mimeType != 'application\/vnd\.google-apps\.folder'/);
});

test("downloadStream streams the file's bytes; Drive errors are reported", async () => {
  fakeGoogle([() => new Response(Buffer.from("audio bytes"))]);
  const chunks = [];
  for await (const chunk of await drive.downloadStream("file-id")) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), "audio bytes");

  fakeGoogle([() => new Response("nope", { status: 404 })]);
  await assert.rejects(drive.downloadStream("gone"), /404/);
});
