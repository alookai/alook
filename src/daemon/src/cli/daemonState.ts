import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { homedir } from "node:os";
import { parseReleaseVersion } from "@alook/shared";
import { ensurePrivateDir, syncDirectory, writePrivateJsonAtomic } from "./privateJsonFile.js";
import { sameDaemonOwnership, type DaemonOwnerContext } from "./daemonOwnership.js";

/**
 * Grace window for a daemon to exit on SIGTERM before we escalate to SIGKILL.
 * Must stay strictly above `SESSION_STOP_GRACE_MS` — the daemon's own SIGTERM
 * handler awaits every agent session's kill (each with its own grace), so this
 * window has to contain those.
 */
const STOP_GRACE_MS = 5000;

const STOP_KILL_GRACE_MS = 2_000;

const POLL_MS = 100;

const MACHINE_ID_PATTERN = /^cm_[A-Za-z0-9_-]{8,64}$/;

const LEGACY_DAEMON_ID_PATTERN = /^[a-f0-9]{12}$/;

function resolveDefaultBaseDir(): string {
  const root = process.env.ALOOK_PROJECT_ROOT || path.join(homedir(), ".alook");
  return path.join(root, "daemon");
}

export const DEFAULT_BASE_DIR = resolveDefaultBaseDir();

export function daemonsDir(baseDir: string): string {
  return path.join(baseDir, "daemons");
}

/**
 * Per-daemon subdirectory. Each daemon's own on-disk files (daemon.pid +
 * status.json + fsm-trace.jsonl + daemon.log) live under `daemons/<id>/`, so
 * multiple daemons sharing a baseDir never clobber a shared file.
 *
 * `<id>` is the daemon's STABLE identity — the server-issued **machineId**
 * (batch C0.1). It was `sha256(opts.machineKey)` (C0), but the reconnect flow
 * mints a fresh one-time `cmt_` every reconnect (all bound to the same
 * machineId), so hashing the CLI key drifted the directory on every reconnect —
 * orphan subdirs + a double-start guard that never fired. machineId is stable
 * across reconnects (activate reuses the same machine row) and is what
 * `daemon list` shows / `daemon stop <id>` takes.
 */
export function daemonDirById(baseDir: string, id: string): string {
  return path.join(daemonsDir(baseDir), validateDaemonId(id));
}

export function validateMachineId(machineId: string): string {
  if (!MACHINE_ID_PATTERN.test(machineId)) throw new Error("invalid machine identity returned by server");
  return machineId;
}

export function isDaemonId(id: string): boolean {
  return MACHINE_ID_PATTERN.test(id) || LEGACY_DAEMON_ID_PATTERN.test(id);
}

function validateDaemonId(id: string): string {
  if (!isDaemonId(id)) throw new Error("invalid daemon id");
  return id;
}

export function pidfilePathById(baseDir: string, id: string): string {
  return path.join(daemonDirById(baseDir, id), "daemon.pid");
}

export function statusFilePathById(baseDir: string, id: string): string {
  return path.join(daemonDirById(baseDir, id), "status.json");
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return !isProcessAlive(pid);
}

export interface DaemonPidFile {
  pid: number;
  machineId?: string;
  startedAt?: string;
  ownerToken?: string;
  key?: string;
}

export interface DaemonReplacementLock {
  pid: number;
  machineId: string;
  startedAt: string;
  ownerToken: string;
  requestId: string;
}

function parsePidFileContent(raw: string): DaemonPidFile | null {
  try {
    const content = JSON.parse(raw);
    if (!Number.isInteger(content.pid) || content.pid <= 0) return null;
    if (
      typeof content.machineId === "string" &&
      typeof content.startedAt === "string" &&
      typeof content.ownerToken === "string"
    ) {
      return {
        pid: content.pid,
        machineId: content.machineId,
        startedAt: content.startedAt,
        ownerToken: content.ownerToken,
      };
    }
    if (typeof content.key === "string") return { pid: content.pid, key: content.key };
  } catch {  }
  return null;
}

export function readPidFile(filePath: string): DaemonPidFile | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return parsePidFileContent(fs.readFileSync(filePath, "utf8"));
  } catch {  }
  return null;
}

function writeExclusive(filePath: string, value: object): void {
  const dir = path.dirname(filePath);
  ensurePrivateDir(dir);
  const tempPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(12).toString("hex")}.tmp`,
  );
  let fd: number | null = fs.openSync(tempPath, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.chmodSync(tempPath, 0o600);
    fs.linkSync(tempPath, filePath);
    syncDirectory(dir);
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {  }
    }
    try { fs.unlinkSync(tempPath); } catch {  }
  }
}

function secureExistingFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile()) throw new Error("unsafe daemon ownership file type");
  fs.chmodSync(filePath, 0o600);
}

export function removeOwnedFile(filePath: string, pid: number, ownerToken: string): void {
  try {
    const content = readPidFile(filePath);
    if (content?.pid === pid && content.ownerToken === ownerToken) {
      fs.unlinkSync(filePath);
    }
  } catch {  }
}

export function removePidFileIfMatches(filePath: string, expected: DaemonPidFile): void {
  if (expected.ownerToken) {
    removeOwnedFile(filePath, expected.pid, expected.ownerToken);
    return;
  }
  try {
    const current = readPidFile(filePath);
    if (current?.pid === expected.pid && current.key === expected.key) fs.unlinkSync(filePath);
  } catch {  }
}

function malformedPidHint(raw: string): number | null {
  const match = raw.match(/"pid"\s*:\s*(\d+)/);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function clearStaleOwnership(filePath: string, liveError: (pid: number) => Error): void {
  if (!fs.existsSync(filePath)) return;
  const valid = readPidFile(filePath);
  if (valid) {
    if (isProcessAlive(valid.pid)) throw liveError(valid.pid);
    removePidFileIfMatches(filePath, valid);
    return;
  }

  let raw: string;
  let before: fs.Stats;
  try {
    before = fs.statSync(filePath);
    raw = fs.readFileSync(filePath, "utf8");
    const afterRead = fs.statSync(filePath);
    if (
      afterRead.dev !== before.dev ||
      afterRead.ino !== before.ino ||
      afterRead.size !== before.size ||
      afterRead.mtimeMs !== before.mtimeMs
    ) return;
  } catch {
    return;
  }
  const pid = malformedPidHint(raw);
  if (pid && isProcessAlive(pid)) throw liveError(pid);
  try {
    const current = fs.statSync(filePath);
    if (
      current.dev !== before.dev ||
      current.ino !== before.ino ||
      current.size !== before.size ||
      current.mtimeMs !== before.mtimeMs
    ) return;
    fs.unlinkSync(filePath);
  } catch {  }
}

export function replacementLockPathById(baseDir: string, machineId: string): string {
  return path.join(daemonDirById(baseDir, machineId), "daemon.replace.lock");
}

export function readReplacementLock(filePath: string): DaemonReplacementLock | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile()) throw new Error("unsafe daemon replacement lock type");
    fs.chmodSync(filePath, 0o600);
    const content = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<DaemonReplacementLock>;
    if (
      !Number.isInteger(content.pid)
      || (content.pid ?? 0) <= 0
      || typeof content.machineId !== "string"
      || typeof content.startedAt !== "string"
      || typeof content.ownerToken !== "string"
      || typeof content.requestId !== "string"
    ) return null;
    return content as DaemonReplacementLock;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function replacementLocksEqual(a: DaemonReplacementLock, b: DaemonReplacementLock): boolean {
  return a.pid === b.pid
    && a.machineId === b.machineId
    && a.startedAt === b.startedAt
    && a.ownerToken === b.ownerToken
    && a.requestId === b.requestId;
}

export function removeReplacementLockIfMatches(
  filePath: string,
  expected: DaemonReplacementLock,
): void {
  try {
    const current = readReplacementLock(filePath);
    if (current && replacementLocksEqual(current, expected)) fs.unlinkSync(filePath);
  } catch {  }
}

function checkReplacementLock(
  baseDir: string,
  machineId: string,
  resumeRequestId?: string,
): void {
  const lockPath = replacementLockPathById(baseDir, machineId);
  if (!fs.existsSync(lockPath)) return;
  const lock = readReplacementLock(lockPath);
  if (!lock) {
    let before: fs.Stats;
    let raw: string;
    try {
      before = fs.statSync(lockPath);
      raw = fs.readFileSync(lockPath, "utf8");
      const afterRead = fs.statSync(lockPath);
      if (
        afterRead.dev !== before.dev
        || afterRead.ino !== before.ino
        || afterRead.size !== before.size
        || afterRead.mtimeMs !== before.mtimeMs
      ) throw new Error(`daemon '${machineId}' replacement lock changed during recovery`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return;
      throw error;
    }
    const pid = malformedPidHint(raw);
    if (pid && isProcessAlive(pid)) {
      throw new Error(`daemon '${machineId}' replacement lock is malformed but owned by live pid ${pid}`);
    }
    try {
      const current = fs.statSync(lockPath);
      if (
        current.dev === before.dev
        && current.ino === before.ino
        && current.size === before.size
        && current.mtimeMs === before.mtimeMs
      ) fs.unlinkSync(lockPath);
    } catch {  }
    return;
  }
  if (!isProcessAlive(lock.pid)) {
    removeReplacementLockIfMatches(lockPath, lock);
    return;
  }
  if (resumeRequestId && lock.requestId === resumeRequestId) return;
  throw new Error(`daemon '${machineId}' replacement already in progress (pid ${lock.pid})`);
}

export function acquireDaemonReplacementLock(args: {
  baseDir: string;
  machineId: string;
  requestId: string;
}): { path: string; lock: DaemonReplacementLock } {
  const lockPath = replacementLockPathById(args.baseDir, args.machineId);
  ensurePrivateDir(path.dirname(lockPath));
  checkReplacementLock(args.baseDir, args.machineId);
  const lock: DaemonReplacementLock = {
    pid: process.pid,
    machineId: args.machineId,
    startedAt: new Date().toISOString(),
    ownerToken: crypto.randomBytes(24).toString("base64url"),
    requestId: args.requestId,
  };
  writeExclusive(lockPath, lock);
  return { path: lockPath, lock };
}

/**
 * COARSE start-lock for first pairing only: the machineId isn't known until
 * after async `/activate`, so this baseDir-level lock blocks a duplicate local
 * start during that window. Exact-machine reconnect already owns its replacement
 * request and goes straight to the per-machine launch lock.
 */
function coarseStartLockPath(baseDir: string): string {
  return path.join(daemonsDir(baseDir), ".start.lock");
}

export function acquireCoarseLock(baseDir: string, ownerToken: string): string {
  const lf = coarseStartLockPath(baseDir);
  ensurePrivateDir(path.dirname(lf));
  secureExistingFile(lf);
  clearStaleOwnership(lf, (pid) => new Error(`another daemon start is in progress on this machine (pid ${pid})`));
  writeExclusive(lf, { pid: process.pid, machineId: "coarse", startedAt: new Date().toISOString(), ownerToken });
  return lf;
}

export function acquireLaunchLock(
  baseDir: string,
  machineId: string,
  ownerToken: string,
  resumeRequestId?: string,
): string {
  const daemonDir = daemonDirById(baseDir, machineId);
  ensurePrivateDir(daemonDir);
  const lockPath = path.join(daemonDir, "daemon.launch.lock");
  const finalPath = pidfilePathById(baseDir, machineId);
  checkReplacementLock(baseDir, machineId, resumeRequestId);
  secureExistingFile(lockPath);
  secureExistingFile(finalPath);
  clearStaleOwnership(finalPath, (pid) => new Error(`daemon '${machineId}' already running (pid ${pid})`));
  clearStaleOwnership(lockPath, (pid) => new Error(`daemon '${machineId}' start already in progress (pid ${pid})`));
  writeExclusive(lockPath, { pid: process.pid, machineId, startedAt: new Date().toISOString(), ownerToken });
  return lockPath;
}

export function commitFinalPidfile(
  baseDir: string,
  machineId: string,
  pid: number,
  startedAt: string,
  ownerToken: string,
): string {
  const filePath = pidfilePathById(baseDir, machineId);
  writeExclusive(filePath, { pid, machineId, startedAt, ownerToken });
  return filePath;
}

function legacyPidfileCandidates(baseDir: string): string[] {
  const dir = daemonsDir(baseDir);
  if (!fs.existsSync(dir)) return [];
  const candidates: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      candidates.push(path.join(dir, entry.name, "daemon.pid"));
    } else if (entry.isFile() && entry.name.endsWith(".pid")) {
      candidates.push(path.join(dir, entry.name));
    }
  }
  return candidates;
}

export function reconcileLegacyMachineKeyOwnership(baseDir: string, machineKey: string): void {
  for (const candidate of legacyPidfileCandidates(baseDir)) {
    const owner = readPidFile(candidate);
    if (!owner?.key || owner.key !== machineKey) continue;
    secureExistingFile(candidate);
    const current = readPidFile(candidate);
    if (!current?.key || current.key !== machineKey) continue;
    if (isProcessAlive(current.pid)) {
      throw new Error(`legacy daemon already running (pid ${current.pid})`);
    }
    removePidFileIfMatches(candidate, current);
  }
}

/**
 * Core stop: SIGTERM → wait for the daemon's own ordered shutdown (stopAll
 * agent children, close channel/proxy, remove pidfile) → escalate to SIGKILL
 * only if it overruns the grace window. This kill/teardown semantic is
 * unchanged by stop-by-id —
 * only HOW the daemon is addressed changed (its list id, not a machine key).
 */
export async function stopExactPid(pid: number): Promise<void> {
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (isProcessAlive(pid)) throw error;
  }

  if (!await waitForPidExit(pid, STOP_GRACE_MS)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (isProcessAlive(pid)) throw error;
    }
    if (!await waitForPidExit(pid, STOP_KILL_GRACE_MS)) {
      throw new Error(`daemon (pid ${pid}) is still running after SIGKILL`);
    }
  }
}

export async function stopExactDaemonPid(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("invalid daemon pid");
  await stopExactPid(pid);
}

export interface DaemonLaunchRecord {
  schemaVersion: 1;
  credential: string;
  machineId: string;
  serverUrl: string;
  wsUrl: string;
  daemonVersion: string;
}

/**
 * Path to the persisted `cmk_` credential file for a paired machine.
 * Derived from the server-supplied `machineId` (stable across credential
 * rotates), so the file self-overwrites on reconnect and no orphaned 0600
 * files accumulate on disk.
 */
export function credentialFilePathByMachineId(baseDir: string, machineId: string): string {
  return path.join(daemonsDir(baseDir), `${validateMachineId(machineId)}.credential.json`);
}

export function savedDaemonMachineIds(opts: { baseDir?: string } = {}): string[] {
  const baseDir = opts.baseDir || process.env.ALOOK_DATA_DIR || DEFAULT_BASE_DIR;
  const dir = daemonsDir(baseDir);
  let entries: string[];
  try { entries = fs.readdirSync(dir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((name) => name.endsWith(".credential.json"))
    .map((name) => name.slice(0, -".credential.json".length))
    .filter((id) => MACHINE_ID_PATTERN.test(id))
    .sort();
}

export function readCredentialFile(filePath: string): (DaemonLaunchRecord | { credential: string; machineId: string }) | null {
  if (!fs.existsSync(filePath)) return null;
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile()) throw new Error("unsafe daemon credential file type");
  fs.chmodSync(filePath, 0o600);
  try {
    const content = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (
      typeof content.credential === "string" &&
      content.credential.startsWith("cmk_") &&
      typeof content.machineId === "string"
    ) {
      if (
        content.schemaVersion === 1
        && typeof content.serverUrl === "string"
        && typeof content.wsUrl === "string"
        && typeof content.daemonVersion === "string"
      ) {
        return {
          schemaVersion: 1,
          credential: content.credential,
          machineId: content.machineId,
          serverUrl: content.serverUrl,
          wsUrl: content.wsUrl,
          daemonVersion: content.daemonVersion,
        };
      }
      return { credential: content.credential, machineId: content.machineId };
    }
  } catch { /* malformed */ }
  return null;
}

export function writeCredentialFile(filePath: string, record: DaemonLaunchRecord): void {
  writePrivateJsonAtomic(filePath, record);
}

export function readDaemonLaunchRecord(baseDir: string, machineId: string): DaemonLaunchRecord {
  const record = readCredentialFile(credentialFilePathByMachineId(baseDir, machineId));
  if (
    !record
    || !("schemaVersion" in record)
    || record.schemaVersion !== 1
    || !parseReleaseVersion(record.daemonVersion)
  ) {
    throw new Error("daemon launch record is missing or requires a manual start upgrade");
  }
  validateMachineId(record.machineId);
  if (record.machineId !== machineId) throw new Error("daemon launch record machine mismatch");
  return record;
}

/**
 * Look through the daemons dir for a `<machineId>.credential.json` whose
 * stored bearer matches. Used when the caller passes an already-issued
 * `cmk_` so we can restore the paired `machineId` without a server call.
 */
export function findExistingCredentialForBearer(
  baseDir: string,
  bearer: string
): { credential: string; machineId: string } | null {
  const dir = daemonsDir(baseDir);
  if (!fs.existsSync(dir)) return null;
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".credential.json")) continue;
    const parsed = readCredentialFile(path.join(dir, file));
    if (parsed && parsed.credential === bearer) return parsed;
  }
  return null;
}

export function daemonProcessArguments(action: "run" | "refresh-run"): string[] {
  const command = process.env.ALOOK_DAEMON_PACKAGE_WRAPPER === "1" ? [action] : ["daemon", action];
  return [...process.execArgv, process.argv[1]!, ...command];
}

export function ownsDaemon(context: DaemonOwnerContext): boolean {
  const current = readPidFile(pidfilePathById(context.baseDir, context.machineId));
  return sameDaemonOwnership(current, context);
}
