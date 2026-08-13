import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { parseReleaseVersion, releaseVersionGte } from "@alook/shared";
import { readDaemonVersion } from "../version.js";
import type { Logger } from "../logger.js";
import {
  acquireDaemonReplacementLock,
  daemonDirById,
  daemonResume,
  pidfilePathById,
  readDaemonLaunchRecord,
  readPidFile,
  removeReplacementLockIfMatches,
  stopExactDaemonPid,
  type DaemonPidFile,
} from "./daemonStart.js";

const UPDATE_INTENT_SCHEMA_VERSION = 1;
const UPDATE_LOG_MAX_BYTES = 512 * 1024;
const UPDATE_LOG_KEEP_BYTES = 256 * 1024;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export interface DaemonUpdateIntent {
  schemaVersion: 1;
  requestId: string;
  pid: number;
  machineId: string;
  startedAt: string;
  ownerToken: string;
}

export interface DaemonSelfUpdateContext {
  machineId: string;
  baseDir: string;
  pid: number;
  startedAt: string;
  ownerToken: string;
}

export interface SelfUpdateDeps {
  spawnProcess?: typeof spawn;
  npmExecPath?: string;
  logger?: Pick<Logger, "info" | "warn">;
}

function intentPath(baseDir: string, machineId: string): string {
  return path.join(daemonDirById(baseDir, machineId), "update-intent.json");
}

export function updateLogPath(baseDir: string, machineId: string): string {
  return path.join(daemonDirById(baseDir, machineId), "update.log");
}

export function updatePackageMapPath(baseDir: string, machineId: string): string {
  return path.join(daemonDirById(baseDir, machineId), "update-package-map.json");
}

function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

function writePrivateJsonAtomic(filePath: string, value: object): void {
  const dir = path.dirname(filePath);
  ensurePrivateDir(dir);
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`);
  let fd: number | null = fs.openSync(tempPath, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.chmodSync(tempPath, 0o600);
    fs.renameSync(tempPath, filePath);
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* best effort */ }
    }
    try { fs.unlinkSync(tempPath); } catch { /* best effort */ }
  }
}

function scrub(value: unknown): string {
  return (value instanceof Error ? value.message : String(value))
    .replace(/\b(?:cmk|cmt)_[A-Za-z0-9_-]+\b/g, "[redacted-token]")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 1_024);
}

function appendUpdateLog(baseDir: string, machineId: string, event: string, fields: Record<string, unknown> = {}): void {
  const filePath = updateLogPath(baseDir, machineId);
  ensurePrivateDir(path.dirname(filePath));
  try {
    if (fs.existsSync(filePath) && fs.statSync(filePath).size > UPDATE_LOG_MAX_BYTES) {
      const data = fs.readFileSync(filePath);
      fs.writeFileSync(filePath, data.subarray(Math.max(0, data.length - UPDATE_LOG_KEEP_BYTES)), { mode: 0o600 });
    }
    const safeFields = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, scrub(value)]));
    fs.appendFileSync(filePath, `${JSON.stringify({ time: new Date().toISOString(), event, ...safeFields })}\n`, { mode: 0o600 });
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Update logging is diagnostic only and cannot own process correctness.
  }
}

function pidTuple(value: DaemonPidFile | null): Omit<DaemonUpdateIntent, "schemaVersion" | "requestId"> | null {
  if (
    !value
    || typeof value.machineId !== "string"
    || typeof value.startedAt !== "string"
    || typeof value.ownerToken !== "string"
  ) return null;
  return {
    pid: value.pid,
    machineId: value.machineId,
    startedAt: value.startedAt,
    ownerToken: value.ownerToken,
  };
}

function tuplesEqual(
  value: ReturnType<typeof pidTuple>,
  expected: Pick<DaemonUpdateIntent, "pid" | "machineId" | "startedAt" | "ownerToken">,
): boolean {
  return value?.pid === expected.pid
    && value.machineId === expected.machineId
    && value.startedAt === expected.startedAt
    && value.ownerToken === expected.ownerToken;
}

function readIntent(baseDir: string, machineId: string): DaemonUpdateIntent {
  const filePath = intentPath(baseDir, machineId);
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile()) throw new Error("unsafe daemon update intent type");
  fs.chmodSync(filePath, 0o600);
  const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<DaemonUpdateIntent>;
  if (
    value.schemaVersion !== UPDATE_INTENT_SCHEMA_VERSION
    || typeof value.requestId !== "string"
    || !REQUEST_ID_PATTERN.test(value.requestId)
    || !Number.isInteger(value.pid)
    || (value.pid ?? 0) <= 0
    || typeof value.machineId !== "string"
    || typeof value.startedAt !== "string"
    || typeof value.ownerToken !== "string"
  ) throw new Error("invalid daemon update intent");
  return value as DaemonUpdateIntent;
}

function removeIntentIfMatches(baseDir: string, machineId: string, requestId: string): void {
  try {
    const current = readIntent(baseDir, machineId);
    if (current.requestId === requestId) fs.unlinkSync(intentPath(baseDir, machineId));
  } catch { /* best effort */ }
}

function npmExecPath(explicit?: string): string {
  const value = explicit ?? process.env.npm_execpath;
  if (!value || !path.isAbsolute(value) || !fs.existsSync(value)) {
    throw new Error("npm launch context unavailable; daemon remains online");
  }
  return value;
}

function readTestPackageMap(baseDir: string, machineId: string): Record<string, string> | null {
  if (process.env.NODE_ENV !== "test") return null;
  const filePath = updatePackageMapPath(baseDir, machineId);
  if (!fs.existsSync(filePath)) return null;
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile()) throw new Error("unsafe daemon update package map type");
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error("daemon update package map must be mode 0600");
  }
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid daemon update package map");
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key !== "latest" && !parseReleaseVersion(key)) throw new Error("invalid daemon update package map key");
    if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error("invalid daemon update package map value");
    result[key] = value;
  }
  return result;
}

function packageSpec(baseDir: string, machineId: string, version: "latest" | string): string {
  const mapped = readTestPackageMap(baseDir, machineId)?.[version];
  if (mapped) return mapped;
  return `@alook/daemon@${version}`;
}

function fixedNpmArgs(args: {
  npmPath: string;
  packageSpec: string;
  command: "replace" | "resume";
  machineId: string;
  baseDir: string;
  requestId: string;
}): string[] {
  return [
    args.npmPath,
    "exec",
    "--yes",
    `--package=${args.packageSpec}`,
    "--",
    "alook-daemon",
    "daemon",
    args.command,
    "--id",
    args.machineId,
    "--base-dir",
    args.baseDir,
    "--request-id",
    args.requestId,
  ];
}

function openUpdateLog(baseDir: string, machineId: string): number {
  appendUpdateLog(baseDir, machineId, "helper_spawn_requested");
  const filePath = updateLogPath(baseDir, machineId);
  const fd = fs.openSync(filePath, "a", 0o600);
  fs.chmodSync(filePath, 0o600);
  return fd;
}

export function createDaemonSelfUpdateHandler(
  context: DaemonSelfUpdateContext,
  deps: SelfUpdateDeps = {},
): () => void {
  let updateInFlight: ChildProcess | null = null;
  return () => {
    if (updateInFlight && updateInFlight.exitCode === null && updateInFlight.signalCode === null) return;
    let requestId = "";
    try {
      const current = pidTuple(readPidFile(pidfilePathById(context.baseDir, context.machineId)));
      if (
        !current
        || current.pid !== context.pid
        || current.machineId !== context.machineId
        || current.startedAt !== context.startedAt
        || current.ownerToken !== context.ownerToken
      ) throw new Error("daemon ownership changed before update launch");
      const npmPath = npmExecPath(deps.npmExecPath);
      requestId = crypto.randomUUID();
      const intent: DaemonUpdateIntent = {
        schemaVersion: UPDATE_INTENT_SCHEMA_VERSION,
        requestId,
        ...current,
      };
      writePrivateJsonAtomic(intentPath(context.baseDir, context.machineId), intent);
      const logFd = openUpdateLog(context.baseDir, context.machineId);
      try {
        const child = (deps.spawnProcess ?? spawn)(process.execPath, fixedNpmArgs({
          npmPath,
          packageSpec: packageSpec(context.baseDir, context.machineId, "latest"),
          command: "replace",
          machineId: context.machineId,
          baseDir: context.baseDir,
          requestId,
        }), {
          detached: true,
          shell: false,
          stdio: ["ignore", logFd, logFd],
        });
        updateInFlight = child;
        const clear = (event: string, fields: Record<string, unknown>): void => {
          appendUpdateLog(context.baseDir, context.machineId, event, fields);
          if (updateInFlight === child) updateInFlight = null;
          removeIntentIfMatches(context.baseDir, context.machineId, requestId);
        };
        child.once("exit", (code, signal) => clear("helper_exited", { code, signal }));
        child.once("error", (error) => clear("helper_process_error", { error }));
        child.unref();
        deps.logger?.info("daemon self-update helper launched", { machineId: context.machineId });
      } finally {
        fs.closeSync(logFd);
      }
    } catch (error) {
      if (requestId) removeIntentIfMatches(context.baseDir, context.machineId, requestId);
      appendUpdateLog(context.baseDir, context.machineId, "helper_spawn_failed", { error });
      deps.logger?.warn("daemon self-update helper launch failed", { machineId: context.machineId, error: scrub(error) });
    }
  };
}

function currentPidTuple(baseDir: string, machineId: string): ReturnType<typeof pidTuple> {
  return pidTuple(readPidFile(pidfilePathById(baseDir, machineId)));
}

function removeOldPidfileIfMatches(baseDir: string, intent: DaemonUpdateIntent): void {
  const filePath = pidfilePathById(baseDir, intent.machineId);
  if (!tuplesEqual(currentPidTuple(baseDir, intent.machineId), intent)) return;
  try { fs.unlinkSync(filePath); } catch { /* best effort */ }
}

async function runPinnedResume(args: {
  npmPath: string;
  version: string;
  machineId: string;
  baseDir: string;
  requestId: string;
}): Promise<void> {
  const fd = openUpdateLog(args.baseDir, args.machineId);
  try {
    const child = spawn(process.execPath, fixedNpmArgs({
      npmPath: args.npmPath,
      packageSpec: packageSpec(args.baseDir, args.machineId, args.version),
      command: "resume",
      machineId: args.machineId,
      baseDir: args.baseDir,
      requestId: args.requestId,
    }), {
      shell: false,
      stdio: ["ignore", fd, fd],
    });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error(`rollback resume exited ${signal ?? code}`));
      });
    });
  } finally {
    fs.closeSync(fd);
  }
}

export async function daemonReplace(opts: {
  id: string;
  baseDir?: string;
  requestId: string;
}): Promise<void> {
  if (!REQUEST_ID_PATTERN.test(opts.requestId)) throw new Error("invalid replacement request id");
  const baseDir = opts.baseDir ?? process.env.ALOOK_DATA_DIR;
  if (!baseDir) throw new Error("daemon replace requires --base-dir");
  const intent = readIntent(baseDir, opts.id);
  if (intent.machineId !== opts.id || intent.requestId !== opts.requestId) {
    throw new Error("daemon update intent mismatch");
  }
  const launch = readDaemonLaunchRecord(baseDir, opts.id);
  const currentVersion = readDaemonVersion();
  if (!parseReleaseVersion(currentVersion) || !parseReleaseVersion(launch.daemonVersion)) {
    throw new Error("daemon replacement version is invalid");
  }
  if (currentVersion === launch.daemonVersion || !releaseVersionGte(currentVersion, launch.daemonVersion)) {
    appendUpdateLog(baseDir, opts.id, "replacement_not_newer", {
      currentVersion,
      priorVersion: launch.daemonVersion,
    });
    removeIntentIfMatches(baseDir, opts.id, opts.requestId);
    return;
  }
  if (!tuplesEqual(currentPidTuple(baseDir, opts.id), intent)) {
    removeIntentIfMatches(baseDir, opts.id, opts.requestId);
    throw new Error("daemon ownership changed before replacement");
  }

  const npmPath = npmExecPath();
  const acquired = acquireDaemonReplacementLock({ baseDir, machineId: opts.id, requestId: opts.requestId });
  let oldStopped = false;
  try {
    if (!tuplesEqual(currentPidTuple(baseDir, opts.id), intent)) {
      throw new Error("daemon ownership changed after replacement lock");
    }
    appendUpdateLog(baseDir, opts.id, "replacement_started", {
      priorVersion: launch.daemonVersion,
      nextVersion: currentVersion,
    });
    await stopExactDaemonPid(intent.pid);
    oldStopped = true;
    removeOldPidfileIfMatches(baseDir, intent);
    try {
      await daemonResume({ id: opts.id, baseDir, requestId: opts.requestId });
      appendUpdateLog(baseDir, opts.id, "replacement_ready", { version: currentVersion });
    } catch (error) {
      appendUpdateLog(baseDir, opts.id, "replacement_start_failed", { error });
      await runPinnedResume({
        npmPath,
        version: launch.daemonVersion,
        machineId: opts.id,
        baseDir,
        requestId: opts.requestId,
      });
      appendUpdateLog(baseDir, opts.id, "rollback_ready", { version: launch.daemonVersion });
    }
  } catch (error) {
    appendUpdateLog(baseDir, opts.id, oldStopped ? "replacement_terminal_failure" : "replacement_aborted", { error });
    throw error;
  } finally {
    removeIntentIfMatches(baseDir, opts.id, opts.requestId);
    removeReplacementLockIfMatches(acquired.path, acquired.lock);
  }
}
