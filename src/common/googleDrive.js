// Read-only Google Drive access (raw REST + fetch, like googleCalendar.js — see
// its header for why there's no client library). Uses the service account, which
// is enough to LIST and DOWNLOAD files shared with it; it can't create files
// (service accounts have no Drive storage quota — that's why the backups live
// in Discord instead).

import { Readable } from "stream";
import { getServiceAccountToken } from "./googleAuth.js";

const API = "https://www.googleapis.com/drive/v3";
const SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const FILE_FIELDS = "id, name, mimeType, size, modifiedTime";

async function driveFetch(url) {
  const token = await getServiceAccountToken(SCOPE);
  if (!token) throw new Error("Google service account isn't configured (GOOGLE_SERVICE_ACCOUNT_KEY)");
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Google Drive request failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res;
}

const escapeQueryValue = (value) => value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

async function listAll(query, fields) {
  const items = [];
  let pageToken;
  do {
    const params = new URLSearchParams({ q: query, fields: `nextPageToken, files(${fields})`, pageSize: "1000", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
    if (pageToken) params.set("pageToken", pageToken);
    const body = await (await driveFetch(`${API}/files?${params}`)).json();
    items.push(...body.files);
    pageToken = body.nextPageToken;
  } while (pageToken);
  return items;
}

// Resolves a folder path like ["Alani", "Dev public pool"] to the last
// folder's id. The first name is looked up among folders SHARED with the
// service account (it has no "My Drive" of its own); each later one inside the
// previous. Several folders may share a name (e.g. the Live User Handler's own "Alani" folder, shared with
// the bot so it can play uploads): each is tried until the whole path is found. Never creates anything.
export async function resolveFolderPath(segments) {
  const found = await resolveFrom(segments, 0, null);
  if (!found) throw new Error(`Drive folder path "${segments.join("/")}" not found — check it exists and is shared with the bot's service account`);
  return found;
}

async function resolveFrom(segments, index, parentId) {
  if (index === segments.length) return parentId;
  const scope = parentId ? `'${escapeQueryValue(parentId)}' in parents` : "sharedWithMe = true";
  const matches = await listAll(`mimeType = '${FOLDER_MIME}' and name = '${escapeQueryValue(segments[index])}' and trashed = false and ${scope}`, "id, name");
  for (const match of matches) {
    const found = await resolveFrom(segments, index + 1, match.id);
    if (found) return found;
  }
  return null;
}

// Files (not folders) directly inside a folder: [{ id, name, mimeType, size, modifiedTime }].
export function listFiles(folderId) {
  return listAll(`'${escapeQueryValue(folderId)}' in parents and trashed = false and mimeType != '${FOLDER_MIME}'`, FILE_FIELDS);
}

// The file's bytes as a Node stream, from the start.
export async function downloadStream(fileId) {
  const res = await driveFetch(`${API}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`);
  return Readable.fromWeb(res.body);
}
