import { mkdirSync, writeFileSync, readFileSync, unlinkSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { acquireLock, releaseLock } from "./filelock.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ module: "steering" });

export interface KillIntent {
  reason: "superseded" | "cancelled";
  targetTaskId: string;
  expectedPid?: number | null;
  successorTaskId?: string | null;
}

const INTENT_DIR_NAME = ".kill_intents";
const STEERING_LOCK_DIR = ".steering_locks";
const INTENT_STALE_MS = 10 * 60 * 1000; // 10 minutes

function intentFilePath(baseDir: string, taskId: string): string {
  return join(baseDir, INTENT_DIR_NAME, `${taskId}.json`);
}

function intentDirPath(baseDir: string): string {
  return join(baseDir, INTENT_DIR_NAME);
}

function steeringLockPath(baseDir: string, contextKey: string): string {
  const safeKey = contextKey.replace(/[^a-zA-Z0-9_:-]/g, "_");
  return join(baseDir, STEERING_LOCK_DIR, safeKey);
}

export function writeKillIntent(baseDir: string, intent: KillIntent): void {
  const dir = intentDirPath(baseDir);
  try {
    mkdirSync(dir, { recursive: true });
  } catch { /* already exists */ }

  const filePath = intentFilePath(baseDir, intent.targetTaskId);
  writeFileSync(filePath, JSON.stringify(intent));
}

export function readKillIntent(baseDir: string, taskId: string): KillIntent | null {
  const filePath = intentFilePath(baseDir, taskId);
  try {
    const content = readFileSync(filePath, "utf-8");
    return JSON.parse(content) as KillIntent;
  } catch {
    return null;
  }
}

export function clearKillIntent(baseDir: string, taskId: string): void {
  const filePath = intentFilePath(baseDir, taskId);
  try {
    unlinkSync(filePath);
  } catch { /* already removed */ }
}

export function cleanupStaleIntents(baseDir: string): void {
  const dir = intentDirPath(baseDir);
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return;
  }
  const now = Date.now();
  for (const file of files) {
    const filePath = join(dir, file);
    try {
      const content = readFileSync(filePath, "utf-8");
      const intent = JSON.parse(content) as KillIntent;
      const stat = statSync(filePath);
      if (now - stat.mtimeMs > INTENT_STALE_MS) {
        unlinkSync(filePath);
        log.debug(`Cleaned up stale kill intent for task ${intent.targetTaskId}`);
      }
    } catch { /* best-effort */ }
  }
}

export function acquireSteeringLock(baseDir: string, contextKey: string): boolean {
  const lockPath = steeringLockPath(baseDir, contextKey);
  try {
    mkdirSync(join(baseDir, STEERING_LOCK_DIR), { recursive: true });
  } catch { /* already exists */ }
  return acquireLock(lockPath, 60_000);
}

export function releaseSteeringLock(baseDir: string, contextKey: string): void {
  const lockPath = steeringLockPath(baseDir, contextKey);
  releaseLock(lockPath);
}
