// Thin wrapper around the Google Drive v3 REST API (raw fetch, no client
// library — see googleCalendar.js's header for why). Acts as the user who
// granted GOOGLE_OAUTH_REFRESH_TOKEN, so files it creates are owned by
// that user and count against their storage. See googleAuth.js for why the
// service account can't be used here.
//
// Every function is plain data in / data out (ids, names, Buffers); the
// cloud-backup feature depends only on this shape, which is what lets its
// tests substitute an in-memory Drive.

import { getOAuthToken } from "./googleAuth.js";
import { sleep } from "./discordApi.js";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;

// fetch with a bearer token and a few retries for Drive's transient
// failures (rate limits, 5xx) — a backup run shouldn't die on one blip.
async function driveFetch(url, options = {}) {
  for (let attempt = 1; ; attempt++) {
    const token = await getOAuthToken();
    const res = await fetch(url, { ...options, headers: { Authorization: `Bearer ${token}`, ...options.headers } });
    if (res.ok) return res;
    if (RETRYABLE_STATUSES.has(res.status) && attempt < MAX_ATTEMPTS) {
      await sleep(1000 * 2 ** (attempt - 1));
      continue;
    }
    throw new Error(`Google Drive ${options.method ?? "GET"} ${url} failed: ${res.status} ${await res.text()}`);
  }
}

const escapeQueryValue = (value) => value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

// All non-trashed children of a folder matching `extraQuery`, following
// pagination.
async function listChildren(parentId, extraQuery = "") {
  const query = `'${escapeQueryValue(parentId)}' in parents and trashed = false${extraQuery}`;
  const items = [];
  let pageToken;
  do {
    const params = new URLSearchParams({ q: query, fields: "nextPageToken, files(id, name)", pageSize: "1000" });
    if (pageToken) params.set("pageToken", pageToken);
    const body = await (await driveFetch(`${API}/files?${params}`)).json();
    items.push(...body.files);
    pageToken = body.nextPageToken;
  } while (pageToken);
  return items;
}

export function listFolders(parentId) {
  return listChildren(parentId, ` and mimeType = '${FOLDER_MIME}'`);
}

export function listFiles(parentId) {
  return listChildren(parentId, ` and mimeType != '${FOLDER_MIME}'`);
}

// Resolves a path of folder names starting at My Drive's root, e.g.
// ["Alani", "DB Backup"], to the last folder's id. Never creates anything:
// the folders are set up by the user, and a typo'd path should fail loudly
// rather than silently backing up somewhere new.
export async function resolveFolderPath(segments) {
  let parentId = "root";
  for (const name of segments) {
    const match = (await listFolders(parentId)).find((f) => f.name === name);
    if (!match) throw new Error(`Drive folder "${name}" not found (path: ${segments.join("/")})`);
    parentId = match.id;
  }
  return parentId;
}

export async function createFolder(parentId, name) {
  const res = await driveFetch(`${API}/files?fields=id`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
  });
  return (await res.json()).id;
}

export async function uploadFile(parentId, name, buffer) {
  const boundary = `alani-${Date.now().toString(36)}`;
  const metadata = Buffer.from(JSON.stringify({ name, parents: [parentId] }));
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`),
    metadata,
    Buffer.from(`\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`),
    buffer,
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  const res = await driveFetch(`${UPLOAD_API}/files?uploadType=multipart&fields=id`, {
    method: "POST",
    headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  return (await res.json()).id;
}

export async function downloadFile(fileId) {
  const res = await driveFetch(`${API}/files/${encodeURIComponent(fileId)}?alt=media`);
  return Buffer.from(await res.arrayBuffer());
}

// Permanently deletes a file or folder (with everything inside it).
export async function deleteItem(itemId) {
  await driveFetch(`${API}/files/${encodeURIComponent(itemId)}`, { method: "DELETE" });
}
