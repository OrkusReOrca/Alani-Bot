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

// Resolves a folder path like ["Alani", "Files to play discord VC"] to the last
// folder's id. The first name is looked up among folders SHARED with the
// service account (it has no "My Drive" of its own); each later one inside the
// previous. Never creates anything.
export async function resolveFolderPath(segments) {
  let parentId = null;
  for (const name of segments) {
    const scope = parentId ? `'${escapeQueryValue(parentId)}' in parents` : "sharedWithMe = true";
    const matches = await listAll(`mimeType = '${FOLDER_MIME}' and name = '${escapeQueryValue(name)}' and trashed = false and ${scope}`, "id, name");
    if (matches.length === 0) throw new Error(`Drive folder "${name}" not found (path: ${segments.join("/")}) — check it exists and is shared with the bot's service account`);
    parentId = matches[0].id;
  }
  return parentId;
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
