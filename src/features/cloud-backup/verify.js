// Decides whether a live database can be trusted against the latest stored
// snapshot of it. (That the stored snapshot itself is intact is settled
// earlier: it must decrypt — see crypto.js.) Two facts must then line up:
//
//   1. the live change log continues the snapshot's own log unchanged, and
//   2. snapshot + the log entries written since == the live data.
//
// Whichever fails says which party is suspect: the log ("log") or the live
// data ("host"). All inputs are plain file paths, so this is testable
// without Discord.

import fs from "fs";
import path from "path";
import { maxLogId, readLogTail, logDigest } from "./changeLog.js";
import { openDatabase, dataDigest, alignSchema, replayLog, diffData } from "./snapshot.js";

// Compares one live snapshot copy against the (already decrypted) stored
// copy. Returns { problems: [{ kind: "log"|"host", message, diffs? }], changed }.
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
