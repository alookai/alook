import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from "fs";
import { dirname } from "path";
import { pidFilePath } from "./config.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger({ module: "pidfile" });

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readDaemonPid(profile?: string): number | null {
  try {
    const content = readFileSync(pidFilePath(profile), "utf-8").trim();
    const pid = parseInt(content, 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

/**
 * Write a PID file to prevent duplicate daemon starts.
 * Returns true if acquired, false if another daemon is already running.
 */
export function acquireDaemonPid(profile?: string): boolean {
  const pidPath = pidFilePath(profile);

  try {
    const content = readFileSync(pidPath, "utf-8").trim();
    const existingPid = parseInt(content, 10);
    if (!isNaN(existingPid) && isProcessAlive(existingPid)) {
      log.error(
        `Another daemon is already running (PID ${existingPid}). ` +
          `Remove ${pidPath} if this is stale.`,
      );
      return false;
    }
  } catch {
    // No existing PID file — proceed
  }

  mkdirSync(dirname(pidPath), { recursive: true, mode: 0o700 });
  writeFileSync(pidPath, String(process.pid), { mode: 0o600 });
  return true;
}

/**
 * Remove the pidfile only if its contents match the given PID. Prevents a
 * daemon from deleting someone else's pidfile (e.g. after a PID was reused or
 * a newer daemon acquired the slot).
 */
export function removePidFileIfMatches(pid: number, profile?: string): void {
  const pidPath = pidFilePath(profile);
  const onDisk = readDaemonPid(profile);
  if (onDisk !== pid) return;
  try {
    unlinkSync(pidPath);
  } catch {
    // already removed
  }
}

/** Remove our own pidfile on shutdown. */
export function releaseDaemonPid(profile?: string): void {
  removePidFileIfMatches(process.pid, profile);
}
