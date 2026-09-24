// How backup instances are laid out inside a Drive folder.
//
// One instance = one subfolder holding a copy of every database in the group
// plus a `meta.json` fingerprinting them. Folders are named
// `instance_<sequence>__<timestamp>` and sorted by sequence, oldest first.
// meta.json is uploaded LAST, so an instance without one is a half-finished
// upload and is ignored (and cleaned up) rather than trusted.
//
// Faulty snapshots taken when verification fails live beside them as
// `FAULTY_<timestamp>` and never count toward the retained instances.

import fs from "fs";
import path from "path";
import { checkCloudCopyIntegrity } from "./verify.js";

export const KEEP_INSTANCES = 16;
const FAULTY_PREFIX = "FAULTY_";
const META_FILE = "meta.json";
const INSTANCE_NAME = /^instance_(\d+)__/;

// "2026-09-24T00-00-00Z" — colons aren't friendly in file names.
const stamp = (date) => date.toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "-");

export const instanceFolderName = (sequence, date) => `instance_${String(sequence).padStart(5, "0")}__${stamp(date)}`;
export const faultyFolderName = (date) => `${FAULTY_PREFIX}${stamp(date)}`;
export const fileNameFor = (databaseName) => `${databaseName}.db`;

// Retained instances in a group folder, oldest first.
export async function listInstances(drive, groupFolderId) {
  return (await drive.listFolders(groupFolderId))
    .map((folder) => ({ ...folder, sequence: Number(INSTANCE_NAME.exec(folder.name)?.[1]) }))
    .filter((folder) => Number.isInteger(folder.sequence))
    .sort((a, b) => a.sequence - b.sequence);
}

// Uploads a set of database files plus their meta.json as a new folder and
// returns the folder's id. `files` is [{ name, path }].
export async function uploadFolder(drive, parentId, folderName, files, meta) {
  const folderId = await drive.createFolder(parentId, folderName);
  for (const file of files) await drive.uploadFile(folderId, file.name, fs.readFileSync(file.path));
  await drive.uploadFile(folderId, META_FILE, Buffer.from(JSON.stringify(meta, null, 2)));
  return folderId;
}

// Downloads an instance into destDir. Returns { meta, paths } (paths keyed by
// file name), or null if it has no meta.json (incomplete upload).
export async function downloadInstance(drive, instance, destDir) {
  const files = await drive.listFiles(instance.id);
  const metaFile = files.find((f) => f.name === META_FILE);
  if (!metaFile) return null;

  fs.mkdirSync(destDir, { recursive: true });
  const paths = {};
  for (const file of files) {
    const dest = path.join(destDir, file.name);
    fs.writeFileSync(dest, await drive.downloadFile(file.id));
    paths[file.name] = dest;
  }
  return { meta: JSON.parse(fs.readFileSync(paths[META_FILE], "utf8")), paths };
}

// Integrity problems of a downloaded instance across all the group's
// databases (empty = every file present and matching its recorded fingerprint).
export function instanceIntegrityProblems(databaseNames, downloaded) {
  return databaseNames.flatMap((name) => {
    const file = fileNameFor(name);
    const cloudPath = downloaded.paths[file];
    if (!cloudPath) return [`${name}: file missing from the cloud instance`];
    return checkCloudCopyIntegrity(name, cloudPath, downloaded.meta.files?.[file]);
  });
}
