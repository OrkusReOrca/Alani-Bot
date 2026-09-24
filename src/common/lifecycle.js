// Reports the bot going online/offline in the status channel.
//
// A clean stop (SIGTERM/SIGINT, which is what the hosting panel sends) is
// reported the moment it happens. A crash or hard kill can't report itself,
// so the bot leaves a heartbeat file: on the next boot, if the last run
// never marked a clean shutdown, the offline line is posted then, stamped
// with the last time the bot was seen alive.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { statusOnline, statusOffline } from "./statusLog.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HEARTBEAT_PATH = path.join(__dirname, "..", "..", "data", "status", "heartbeat.json");
const HEARTBEAT_INTERVAL_MS = 60 * 1000;

function readHeartbeat() {
  try {
    return JSON.parse(fs.readFileSync(HEARTBEAT_PATH, "utf8"));
  } catch {
    return null; // first ever boot, or unreadable — nothing to report
  }
}

function writeHeartbeat(cleanShutdown) {
  fs.mkdirSync(path.dirname(HEARTBEAT_PATH), { recursive: true });
  fs.writeFileSync(HEARTBEAT_PATH, JSON.stringify({ lastSeenMs: Date.now(), cleanShutdown }));
}

// onShutdown: awaited after the offline line is posted, before exit —
// e.g. closing the Discord client.
export async function startLifecycleReporting(onShutdown = async () => {}) {
  const previous = readHeartbeat();
  if (previous && !previous.cleanShutdown) {
    await statusOffline({ at: previous.lastSeenMs, unexpected: true });
  }

  writeHeartbeat(false);
  setInterval(() => writeHeartbeat(false), HEARTBEAT_INTERVAL_MS).unref();
  await statusOnline();

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await statusOffline();
    writeHeartbeat(true);
    await onShutdown();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
