import { test } from "node:test";
import assert from "node:assert/strict";

process.env.GOOGLE_OAUTH_CLIENT_ID = "client-id";
process.env.GOOGLE_OAUTH_CLIENT_SECRET = "client-secret";
process.env.GOOGLE_OAUTH_REFRESH_TOKEN = "refresh-token";

const drive = await import("../src/common/googleDrive.js");

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

// Replaces fetch with a scripted sequence of responses and records the calls.
function scriptFetch(handlers) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const handler = handlers.shift();
    assert.ok(handler, `unexpected extra request to ${url}`);
    return handler(String(url), options);
  };
  return calls;
}

const tokenResponse = () => json({ access_token: "access-token", expires_in: 3600 });

test("requests carry the refreshed OAuth token, and the token is reused", async () => {
  const calls = scriptFetch([
    tokenResponse,
    () => json({ files: [{ id: "f1", name: "Alani" }] }),
    () => json({ files: [] }),
  ]);

  await drive.listFolders("root");
  await drive.listFolders("root");

  const tokenCalls = calls.filter((c) => c.url.includes("oauth2.googleapis.com/token"));
  assert.equal(tokenCalls.length, 1);
  assert.match(tokenCalls[0].options.body.toString(), /grant_type=refresh_token/);
  assert.equal(calls[1].options.headers.Authorization, "Bearer access-token");
  assert.equal(
    new URL(calls[1].url).searchParams.get("q"),
    "'root' in parents and trashed = false and mimeType = 'application/vnd.google-apps.folder'"
  );
});

test("resolveFolderPath walks the path from the root and fails loudly on a missing folder", async () => {
  scriptFetch([
    () => json({ files: [{ id: "alani-id", name: "Alani" }] }),
    () => json({ files: [{ id: "db-id", name: "DB Backup" }] }),
  ]);
  assert.equal(await drive.resolveFolderPath(["Alani", "DB Backup"]), "db-id");

  scriptFetch([() => json({ files: [{ id: "alani-id", name: "Alani" }] }), () => json({ files: [] })]);
  await assert.rejects(drive.resolveFolderPath(["Alani", "Nope"]), /"Nope" not found/);
});

test("uploadFile sends multipart metadata plus the raw bytes", async () => {
  const bytes = Buffer.from([0, 1, 2, 250, 251, 252]);
  const calls = scriptFetch([() => json({ id: "new-file" })]);

  assert.equal(await drive.uploadFile("parent-id", "db-core.db", bytes), "new-file");

  const { url, options } = calls[0];
  assert.match(url, /upload\/drive\/v3\/files\?uploadType=multipart/);
  assert.match(options.headers["Content-Type"], /^multipart\/related; boundary=/);
  const body = options.body;
  assert.ok(body.includes(Buffer.from(JSON.stringify({ name: "db-core.db", parents: ["parent-id"] }))));
  assert.ok(body.includes(bytes));
});

test("transient Drive failures are retried, permanent ones are not", async () => {
  const calls = scriptFetch([() => json({}, 503), () => json({ id: "made" })]);
  assert.equal(await drive.createFolder("parent", "instance_00001"), "made");
  assert.equal(calls.length, 2);

  scriptFetch([() => json({ error: "forbidden" }, 403)]);
  await assert.rejects(drive.createFolder("parent", "x"), /403/);
});

test("downloadFile returns the file's bytes; deleteItem issues a DELETE", async () => {
  const bytes = Buffer.from("sqlite bytes");
  const calls = scriptFetch([() => new Response(bytes), () => new Response(null, { status: 204 })]);

  assert.deepEqual(await drive.downloadFile("file-id"), bytes);
  await drive.deleteItem("file-id");
  assert.match(calls[0].url, /files\/file-id\?alt=media/);
  assert.equal(calls[1].options.method, "DELETE");
});
