// The playable files in the Drive folder, with a short-lived listing cache so
// back-to-back commands don't each hit Drive.

import { resolveFolderPath, listFiles } from "../../common/googleDrive.js";
import { config, limits, isPlayableFile } from "./config.js";
import { matchByName } from "./match.js";

let folderId = null;
let cached = null; // { at, files }

// [{ id, name, mimeType, size, modifiedTime }], sorted by name.
export async function listPlayableFiles() {
  if (cached && Date.now() - cached.at < limits.libraryCacheMs) return cached.files;
  folderId ??= await resolveFolderPath(config.folderPath);
  const files = (await listFiles(folderId)).filter(isPlayableFile).sort((a, b) => a.name.localeCompare(b.name));
  cached = { at: Date.now(), files };
  return files;
}

export async function findPlayableFile(query) {
  return matchByName(await listPlayableFiles(), query, (file) => file.name);
}
