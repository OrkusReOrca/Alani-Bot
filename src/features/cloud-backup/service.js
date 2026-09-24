// The cloud backup engine. One pass (runAll) walks every backup group and,
// for each, either:
//
//   - uploads the first-ever instance (nothing stored yet),
//   - does nothing (no change since the latest stored instance),
//   - uploads a new instance (verified changes since the latest one), or
//   - declares a FAULT (verification failed — see verify.js).
//
// On a fault the host's current copy is stored as a separate FAULTY_ item
// (never overwriting anything), the host is reset to the newest intact stored
// instance, and the owner is asked which side should win. The group stays
// paused until they answer via resolveFault().
//
// Everything outside this file is injected (the store, notifier, state,
// groups), so the whole flow runs against an in-memory store in tests. See
// README.md for the design in prose.

import fs from "fs";
import os from "os";
import path from "path";
import { snapshotTo, restoreInto } from "./snapshot.js";
import { compareWithCloudCopy } from "./verify.js";
import { CorruptBackupError } from "./crypto.js";
import { KEEP_INSTANCES, retainedInstances, instanceName, faultyName, fileNameFor } from "./instances.js";
import { formatFaultReport } from "./report.js";

export const RESOLUTIONS = ["cloud", "host"];

// group: { id, label, databases: [{ name, db }] }
// store: { list(groupId), put(groupId, name, files), get(item), remove(item) }
export function createBackupService({ store, groups, state, notifier, dataDir, keepInstances = KEEP_INSTANCES, now = () => new Date() }) {
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

  // Consistent copies of the group's live databases, as files on disk:
  // { "<file>": path }.
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

  const readFiles = (paths) => Object.fromEntries(Object.entries(paths).map(([name, filePath]) => [name, fs.readFileSync(filePath)]));

  function writeFiles(files, destDir) {
    fs.mkdirSync(destDir, { recursive: true });
    return Object.fromEntries(
      Object.entries(files).map(([name, data]) => {
        const dest = path.join(destDir, name);
        fs.writeFileSync(dest, data);
        return [name, dest];
      })
    );
  }

  // Fetches a stored instance onto disk. Returns { paths } on success or
  // { corrupt: <reason> } if it fails to authenticate. Anything else (network,
  // Discord errors) propagates: an outage must not look like corruption.
  async function fetchInstance(item, destDir) {
    try {
      return { paths: writeFiles(await store.get(item), destDir) };
    } catch (err) {
      if (err instanceof CorruptBackupError) return { corrupt: `${item.name}: ${err.message}` };
      throw err;
    }
  }

  async function uploadNewInstance(group, instances, paths) {
    const sequence = (instances.at(-1)?.sequence ?? 0) + 1;
    await store.put(group.id, instanceName(sequence, now()), readFiles(paths));
    // Keep the newest `keepInstances`; the oldest fall off the end.
    const excess = instances.length + 1 - keepInstances;
    for (const old of instances.slice(0, Math.max(0, excess))) await store.remove(old);
  }

  // Compares every live copy against the fetched latest instance.
  function verifyGroup(group, livePaths, latestPaths, workDir) {
    const problems = [];
    let changed = false;
    for (const { name } of group.databases) {
      const file = fileNameFor(name);
      const result = compareWithCloudCopy(name, livePaths[file], latestPaths[file], workDir);
      problems.push(...result.problems);
      changed ||= result.changed;
    }
    return { problems, changed };
  }

  // The newest stored instance that decrypts intact — what the host is reset
  // to on a fault. Walks back from the newest until one is fine.
  async function findTrustedInstance(instances, workDir) {
    for (const item of [...instances].reverse()) {
      const fetched = await fetchInstance(item, path.join(workDir, "cloud", item.name));
      if (fetched.paths) return { item, paths: fetched.paths };
    }
    return null;
  }

  async function handleFault(group, instances, livePaths, problems, workDir) {
    const name = faultyName(now());
    const faultyItemId = await store.put(group.id, name, readFiles(livePaths));

    // Keep the host's copy locally too, so "resume host" needs no re-download.
    const localDir = faultyDirFor(group);
    fs.rmSync(localDir, { recursive: true, force: true });
    fs.mkdirSync(localDir, { recursive: true });
    for (const [file, filePath] of Object.entries(livePaths)) fs.copyFileSync(filePath, path.join(localDir, file));

    const trusted = await findTrustedInstance(instances, workDir);
    if (trusted) {
      for (const { name: dbName, db } of group.databases) restoreInto(db, trusted.paths[fileNameFor(dbName)]);
    }

    const report = formatFaultReport({ group, problems, restoredFrom: trusted?.item.name ?? null, faultyName: name });
    state.setPending(group.id, {
      detectedAt: now().toISOString(),
      faultyItem: { id: faultyItemId, groupId: group.id, name },
      restoredFrom: trusted?.item.name ?? null,
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
      const instances = retainedInstances(await store.list(group.id));
      const latest = instances.at(-1);

      if (!latest) {
        await uploadNewInstance(group, instances, livePaths);
        await notifier.cloudUpdated(group);
        return { groupId: group.id, outcome: "baseline" };
      }

      const fetched = await fetchInstance(latest, path.join(workDir, "cloud", latest.name));
      const { problems, changed } = fetched.corrupt
        ? { problems: [{ kind: "cloud", message: fetched.corrupt }], changed: true }
        : verifyGroup(group, livePaths, fetched.paths, workDir);

      if (problems.length > 0) {
        await handleFault(group, instances, livePaths, problems, workDir);
        return { groupId: group.id, outcome: "fault" };
      }
      if (!changed) return { groupId: group.id, outcome: "unchanged" };

      await uploadNewInstance(group, instances, livePaths);
      await notifier.cloudUpdated(group);
      return { groupId: group.id, outcome: "uploaded" };
    });
  }

  // One full pass over every group. A failure in one group (Discord down,
  // channel missing) is reported for that group and doesn't stop the others.
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

  // The owner's answer to a fault. "cloud": the host already holds the stored
  // version, so just discard the faulty copy. "host": put the faulty copy's
  // data back and store it as the new latest instance.
  async function resolveFault(groupId, choice) {
    const group = groupById(groupId);
    const pending = group && state.pending(groupId);
    if (!pending) return `No unresolved cloud fault for \`${groupId}\`.`;

    if (choice === "host") {
      for (const { name, db } of group.databases) restoreInto(db, path.join(faultyDirFor(group), fileNameFor(name)));
      await withWorkDir(async (workDir) => {
        const instances = retainedInstances(await store.list(group.id));
        await uploadNewInstance(group, instances, snapshotGroup(group, path.join(workDir, "live")));
      });
      await notifier.cloudUpdated(group);
    }

    await store.remove(pending.faultyItem);
    fs.rmSync(faultyDirFor(group), { recursive: true, force: true });
    state.clearPending(groupId);
    return choice === "host"
      ? `Kept the host's version of ${group.label}: saved as the new latest backup, faulty copy deleted.`
      : `Kept the stored version of ${group.label}: faulty copy deleted.`;
  }

  // Human-readable state of every group, for `.a setting cloud status`.
  async function describeStatus() {
    const lines = [];
    for (const group of groups) {
      const pending = state.pending(group.id);
      try {
        const instances = retainedInstances(await store.list(group.id));
        const newest = instances.at(-1);
        lines.push(
          `• **${group.label}** (\`${group.id}\`): ${instances.length}/${keepInstances} instances` +
            (newest ? `, latest \`${newest.name}\`` : "") +
            (pending ? ` — ⚠️ UNRESOLVED FAULT (${pending.faultyItem.name})` : "")
        );
      } catch (err) {
        lines.push(`• **${group.label}** (\`${group.id}\`): couldn't reach the backup channel — ${err.message}`);
      }
    }
    const last = state.lastRunAt();
    lines.push(last ? `Last complete pass: ${last}` : "No complete backup pass yet.");
    return lines.join("\n");
  }

  return {
    runAll,
    resolveFault,
    describeStatus,
    pendingGroupIds: () => Object.keys(state.allPending()),
  };
}
