// The cloud backup engine. One pass (runAll) walks every backup group and,
// for each, either:
//
//   - uploads the first-ever instance (nothing in the cloud yet),
//   - does nothing (no change since the latest cloud instance),
//   - uploads a new instance (verified changes since the latest one), or
//   - declares a FAULT (verification failed — see verify.js).
//
// On a fault the host's current copy is uploaded as a separate FAULTY_
// folder (never overwriting anything), the host is reset to the newest
// intact cloud instance, and the owner is asked which side should win. The
// group stays paused until they answer via resolveFault().
//
// Everything outside this file is injected (Drive client, notifier, state
// store, groups), so the whole flow runs against an in-memory Drive in
// tests. See README.md for the design in prose.

import fs from "fs";
import os from "os";
import path from "path";
import { snapshotTo, restoreInto } from "./snapshot.js";
import { fingerprintFile, compareWithCloudCopy } from "./verify.js";
import {
  KEEP_INSTANCES,
  listInstances,
  uploadFolder,
  downloadInstance,
  instanceIntegrityProblems,
  instanceFolderName,
  faultyFolderName,
  fileNameFor,
} from "./instances.js";
import { formatFaultReport } from "./report.js";

export const RESOLUTIONS = ["drive", "host"];

// group: { id, label, folderPath, databases: [{ name, db }] }
export function createBackupService({ drive, groups, state, notifier, dataDir, keepInstances = KEEP_INSTANCES, now = () => new Date() }) {
  let running = false;

  const groupById = (id) => groups.find((g) => g.id === id);
  const faultyDirFor = (group) => path.join(dataDir, "faulty", group.id);
  const withWorkDir = async (fn) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alani-backup-"));
    try {
      return await fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  // Consistent copies of the group's live databases: { "<file>": path }.
  function snapshotGroup(group, destDir) {
    fs.mkdirSync(destDir, { recursive: true });
    return Object.fromEntries(
      group.databases.map(({ name, db }) => {
        const dest = path.join(destDir, fileNameFor(name));
        snapshotTo(db, dest);
        return [fileNameFor(name), dest];
      })
    );
  }

  const filesOf = (paths) => Object.entries(paths).map(([name, filePath]) => ({ name, path: filePath }));

  function metaFor(sequence, paths, extra = {}) {
    return {
      sequence,
      createdAt: now().toISOString(),
      files: Object.fromEntries(Object.entries(paths).map(([name, filePath]) => [name, fingerprintFile(filePath)])),
      ...extra,
    };
  }

  // Finds the newest complete instance (one with a meta.json) and downloads
  // it. An incomplete upload found on the way (a crash mid-upload) is
  // deleted. Returns { instances: all remaining instances oldest first,
  // latest: { instance, downloaded } | null }.
  async function loadInstances(folderId, workDir) {
    const instances = await listInstances(drive, folderId);
    while (instances.length > 0) {
      const candidate = instances.at(-1);
      const downloaded = await downloadInstance(drive, candidate, path.join(workDir, "cloud", candidate.name));
      if (downloaded) return { instances, latest: { instance: candidate, downloaded } };
      await drive.deleteItem(candidate.id);
      instances.pop();
    }
    return { instances, latest: null };
  }

  async function uploadNewInstance(folderId, instances, paths) {
    const sequence = (instances.at(-1)?.sequence ?? 0) + 1;
    await uploadFolder(drive, folderId, instanceFolderName(sequence, now()), filesOf(paths), metaFor(sequence, paths));
    // Keep the newest `keepInstances`; the oldest fall off the end.
    const excess = instances.length + 1 - keepInstances;
    for (const old of instances.slice(0, Math.max(0, excess))) await drive.deleteItem(old.id);
  }

  // Compares every live copy against the latest cloud instance.
  function verifyGroup(group, livePaths, latest, workDir) {
    const integrity = instanceIntegrityProblems(group.databases.map((d) => d.name), latest.downloaded);
    if (integrity.length > 0) {
      return { problems: integrity.map((message) => ({ kind: "drive", message })), changed: true };
    }

    const problems = [];
    let changed = false;
    for (const { name } of group.databases) {
      const file = fileNameFor(name);
      const result = compareWithCloudCopy(name, livePaths[file], latest.downloaded.paths[file], workDir);
      problems.push(...result.problems);
      changed ||= result.changed;
    }
    return { problems, changed };
  }

  // The newest cloud instance whose files all pass their integrity check —
  // what the host is reset to on a fault. `latest` is passed in (already
  // downloaded); older ones are fetched only if needed.
  async function findTrustedInstance(group, instances, latest, workDir) {
    const names = group.databases.map((d) => d.name);
    if (instanceIntegrityProblems(names, latest.downloaded).length === 0) return latest;
    for (const instance of [...instances].reverse().slice(1)) {
      const downloaded = await downloadInstance(drive, instance, path.join(workDir, "cloud", instance.name));
      if (downloaded && instanceIntegrityProblems(names, downloaded).length === 0) return { instance, downloaded };
    }
    return null;
  }

  async function handleFault(group, folderId, instances, latest, livePaths, problems, workDir) {
    const faultyName = faultyFolderName(now());
    const faultyFolderId = await uploadFolder(
      drive,
      folderId,
      faultyName,
      filesOf(livePaths),
      metaFor(null, livePaths, { faulty: true, problems: problems.map(({ kind, message }) => ({ kind, message })) })
    );

    // Keep the host's copy locally too, so "resume host" needs no re-download.
    const localDir = faultyDirFor(group);
    fs.rmSync(localDir, { recursive: true, force: true });
    fs.mkdirSync(localDir, { recursive: true });
    for (const [file, filePath] of Object.entries(livePaths)) fs.copyFileSync(filePath, path.join(localDir, file));

    const trusted = await findTrustedInstance(group, instances, latest, workDir);
    if (trusted) {
      for (const { name, db } of group.databases) restoreInto(db, trusted.downloaded.paths[fileNameFor(name)]);
    }

    const report = formatFaultReport({
      group,
      problems,
      restoredFrom: trusted?.instance.name ?? null,
      faultyFolderName: faultyName,
    });
    state.setPending(group.id, {
      detectedAt: now().toISOString(),
      faultyFolderId,
      faultyFolderName: faultyName,
      restoredFrom: trusted?.instance.name ?? null,
      report,
    });
    await notifier.fault(group, report);
  }

  async function runGroup(group) {
    const pending = state.pending(group.id);
    if (pending) {
      await notifier.faultStillPending(group, pending);
      return { groupId: group.id, outcome: "pending-fault" };
    }

    return withWorkDir(async (workDir) => {
      const livePaths = snapshotGroup(group, path.join(workDir, "live"));
      const folderId = await drive.resolveFolderPath(group.folderPath);
      const { instances, latest } = await loadInstances(folderId, workDir);

      if (!latest) {
        await uploadNewInstance(folderId, instances, livePaths);
        await notifier.cloudUpdated(group);
        return { groupId: group.id, outcome: "baseline" };
      }

      const { problems, changed } = verifyGroup(group, livePaths, latest, workDir);
      if (problems.length > 0) {
        await handleFault(group, folderId, instances, latest, livePaths, problems, workDir);
        return { groupId: group.id, outcome: "fault" };
      }
      if (!changed) return { groupId: group.id, outcome: "unchanged" };

      await uploadNewInstance(folderId, instances, livePaths);
      await notifier.cloudUpdated(group);
      return { groupId: group.id, outcome: "uploaded" };
    });
  }

  // One full pass over every group. A failure in one group (Drive down,
  // folder missing) is reported for that group and doesn't stop the others.
  async function runAll() {
    if (running) return [{ outcome: "busy" }];
    running = true;
    try {
      const results = [];
      for (const group of groups) {
        try {
          results.push(await runGroup(group));
        } catch (err) {
          console.error(`[cloud-backup] ${group.label} failed:`, err);
          results.push({ groupId: group.id, outcome: "error", error: err.message });
        }
      }
      if (results.every((r) => r.outcome !== "error")) state.markRun(now());
      return results;
    } finally {
      running = false;
    }
  }

  // The owner's answer to a fault. "drive": the host already holds the cloud
  // version, so just discard the faulty copy. "host": put the faulty copy's
  // data back and upload it as the new latest instance.
  async function resolveFault(groupId, choice) {
    const group = groupById(groupId);
    const pending = group && state.pending(groupId);
    if (!pending) return `No unresolved cloud fault for \`${groupId}\`.`;

    if (choice === "host") {
      const localDir = faultyDirFor(group);
      for (const { name, db } of group.databases) restoreInto(db, path.join(localDir, fileNameFor(name)));
      await withWorkDir(async (workDir) => {
        const folderId = await drive.resolveFolderPath(group.folderPath);
        const { instances } = await loadInstances(folderId, workDir);
        await uploadNewInstance(folderId, instances, snapshotGroup(group, path.join(workDir, "live")));
      });
      await notifier.cloudUpdated(group);
    }

    await drive.deleteItem(pending.faultyFolderId);
    fs.rmSync(faultyDirFor(group), { recursive: true, force: true });
    state.clearPending(groupId);
    return choice === "host"
      ? `Kept the host's version of ${group.label}: saved as the new latest cloud instance, faulty copy deleted.`
      : `Kept the cloud version of ${group.label}: faulty copy deleted.`;
  }

  // Human-readable state of every group, for `.a setting cloud status`.
  async function describeStatus() {
    const lines = [];
    for (const group of groups) {
      const pending = state.pending(group.id);
      try {
        const folderId = await drive.resolveFolderPath(group.folderPath);
        const instances = await listInstances(drive, folderId);
        const newest = instances.at(-1);
        lines.push(
          `• **${group.label}** (\`${group.id}\`): ${instances.length}/${keepInstances} instances` +
            (newest ? `, latest \`${newest.name}\`` : "") +
            (pending ? ` — ⚠️ UNRESOLVED FAULT (${pending.faultyFolderName})` : "")
        );
      } catch (err) {
        lines.push(`• **${group.label}** (\`${group.id}\`): couldn't reach Drive — ${err.message}`);
      }
    }
    const last = state.lastRunAt();
    lines.push(last ? `Last complete pass: ${last}` : "No complete backup pass yet.");
    return lines.join("\n");
  }

  return { runAll, resolveFault, describeStatus, groupIds: () => groups.map((g) => g.id), pendingGroupIds: () => Object.keys(state.allPending()) };
}
