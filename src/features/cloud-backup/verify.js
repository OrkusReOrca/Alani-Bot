// Decides whether a live database can be trusted against the latest cloud
// snapshot of it. Three independent facts must line up:
//
//   1. the cloud snapshot is intact (matches the fingerprint recorded
//      when it was uploaded),
//   2. the live change log continues the snapshot's own log unchanged, and
//   3. snapshot + the log entries written since == the live data.
//
// Whichever fails says which party is suspect: the cloud copy ("drive"),
// the log ("log"), or the live data ("host"). All inputs are plain file
// paths, so this is testable without Drive or Discord.

import fs from "fs";
import path from "path";
import { maxLogId, readLogTail, logDigest } from "./changeLog.js";
import { openDatabase, fileSha256, dataDigest, alignSchema, replayLog, diffData } from "./snapshot.js";

// What gets recorded next to an uploaded snapshot so it can be checked
// later. A SHA-256 of the file is enough: identical bytes mean identical data
// and identical change log.
export function fingerprintFile(filePath) {
  return { sha256: fileSha256(filePath) };
}

// Is the downloaded cloud copy exactly what was uploaded? Returns a list of
// human-readable problems (empty = intact). Works on files that aren't even
// valid SQLite, which is exactly what a corrupted upload looks like.
export function checkCloudCopyIntegrity(name, cloudPath, recorded) {
  if (!recorded) return [`${name}: no fingerprint recorded for this file in the cloud instance`];
  if (fileSha256(cloudPath) !== recorded.sha256) {
    return [`${name}: the cloud copy's contents don't match what was uploaded (corrupted or edited in Drive)`];
  }
  return [];
}

// Compares one live snapshot copy against the (already integrity-checked)
// cloud copy. Returns { problems: [{ kind: "log"|"host", message, diffs? }], changed }.
export function compareWithCloudCopy(name, livePath, cloudPath, workDir) {
  const live = openDatabase(livePath);
  const cloud = openDatabase(cloudPath);
  try {
    const cloudMax = maxLogId(cloud);
    const problems = [];

    if (maxLogId(live) < cloudMax || logDigest(live, cloudMax) !== logDigest(cloud, cloudMax)) {
      problems.push({ kind: "log", message: `${name}: the live change log doesn't continue the cloud snapshot's own log (entries up to #${cloudMax} differ or are missing)` });
      return { problems, changed: true };
    }

    const replayed = path.join(workDir, `${name}.replayed.db`);
    fs.copyFileSync(cloudPath, replayed);
    const replayDb = openDatabase(replayed);
    try {
      alignSchema(replayDb, live);
      replayLog(replayDb, readLogTail(live, cloudMax));
      const diffs = diffData(live, replayDb);
      if (diffs.length > 0) {
        problems.push({
          kind: "host",
          message: `${name}: live data differs from cloud snapshot + change log in ${diffs.length} row(s)`,
          diffs,
        });
      }
    } finally {
      replayDb.close();
    }

    return { problems, changed: dataDigest(live) !== dataDigest(cloud) };
  } finally {
    live.close();
    cloud.close();
  }
}
