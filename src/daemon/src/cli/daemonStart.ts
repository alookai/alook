/**
 * `alook daemon start|stop|list` — daemon lifecycle commands.
 *
 * Multiple daemons can run on one physical machine. Each server-issued machine
 * identity owns one private directory and pidfile under `<baseDir>/daemons/`.
 */
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as os from "os";
import { homedir } from "os";
import type { DaemonStatusSnapshot } from "../util/statusFile.js";
import { resolveAlookCliPathWithFallback, detectRuntimes, type RuntimeInfo } from "../discovery.js";
import { createLogger } from "../logger.js";
import { readDaemonVersion } from "../version.js";
import { runPreparedDaemon, type DaemonReadyReceipt, type PreparedDaemon } from "./daemonRunner.js";
import { spawn, type ChildProcess } from "node:child_process";
import {
  CommunityDaemonActivateErrorResponseSchema,
  CommunityDaemonActivateResponseSchema,
  parseReleaseVersion,
} from "@alook/shared";

/**
 * Grace window for a daemon to exit on SIGTERM before we escalate to SIGKILL.
 * Must stay strictly above `AGENT_DRIVER_STOP_GRACE_MS` — the daemon's own SIGTERM
 * handler awaits every agent session's kill (each with its own grace), so this
 * window has to contain those.
 */
const STOP_GRACE_MS = 5000;
const STOP_KILL_GRACE_MS = 2_000;
/** How often `daemonStop` polls `isProcessAlive` while waiting on SIGTERM. */
const POLL_MS = 100;
const START_RECEIPT_TIMEOUT_MS = 15_000;
const PAIRING_ACTIVATION_TIMEOUT_MS = 30_000;
const RUNNER_TERM_GRACE_MS = 2_000;
const RUNNER_KILL_GRACE_MS = 2_000;
const MACHINE_ID_PATTERN = /^cm_[A-Za-z0-9_-]{8,64}$/;
const LEGACY_DAEMON_ID_PATTERN = /^[a-f0-9]{12}$/;
const DEFAULT_SERVER_URL = "https://alook.ai";
const DEFAULT_WS_URL = "wss://alook.ai/api/ws/community-daemon";

function resolveDefaultBaseDir(): string {
  const root = process.env.ALOOK_PROJECT_ROOT || path.join(homedir(), ".alook");
  return path.join(root, "daemon");
}

export const DEFAULT_BASE_DIR = resolveDefaultBaseDir();

const log = createLogger({ header: "@alook/daemon" });

/* ------------------------------------------------------------------ */
/* Per-machine pidfile helpers                                          */
/* ------------------------------------------------------------------ */

function daemonsDir(baseDir: string): string {
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
 * `daemon list` shows / `daemon stop <id>` takes. See
 * plans/daemon-c01-machineid-anchor.md.
 */
export function daemonDirById(baseDir: string, id: string): string {
  return path.join(daemonsDir(baseDir), validateDaemonId(id));
}

function validateMachineId(machineId: string): string {
  if (!MACHINE_ID_PATTERN.test(machineId)) throw new Error("invalid machine identity returned by server");
  return machineId;
}

function isDaemonId(id: string): boolean {
  return MACHINE_ID_PATTERN.test(id) || LEGACY_DAEMON_ID_PATTERN.test(id);
}

function validateDaemonId(id: string): string {
  if (!isDaemonId(id)) throw new Error("invalid daemon id");
  return id;
}

export function pidfilePathById(baseDir: string, id: string): string {
  return path.join(daemonDirById(baseDir, id), "daemon.pid");
}

/** Per-daemon status snapshot: `daemons/<id>/status.json` (id = machineId). */
function statusFilePathById(baseDir: string, id: string): string {
  return path.join(daemonDirById(baseDir, id), "status.json");
}

function isProcessAlive(pid: number): boolean {
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
  } catch { /* malformed */ }
  return null;
}

export function readPidFile(filePath: string): DaemonPidFile | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return parsePidFileContent(fs.readFileSync(filePath, "utf8"));
  } catch { /* malformed */ }
  return null;
}

function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

function syncDirectory(dir: string): void {
  if (process.platform === "win32") return;
  const fd = fs.openSync(dir, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
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
      try { fs.closeSync(fd); } catch { /* best effort */ }
    }
    try { fs.unlinkSync(tempPath); } catch { /* best effort */ }
  }
}

function writePrivateJsonAtomic(filePath: string, value: object): void {
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
    fs.renameSync(tempPath, filePath);
    syncDirectory(dir);
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* best effort */ }
    }
    try { fs.unlinkSync(tempPath); } catch { /* best effort */ }
  }
}

function secureExistingFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile()) throw new Error("unsafe daemon ownership file type");
  fs.chmodSync(filePath, 0o600);
}

function removeOwnedFile(filePath: string, pid: number, ownerToken: string): void {
  try {
    const content = readPidFile(filePath);
    if (content?.pid === pid && content.ownerToken === ownerToken) {
      fs.unlinkSync(filePath);
    }
  } catch { /* best effort */ }
}

function removePidFileIfMatches(filePath: string, expected: DaemonPidFile): void {
  if (expected.ownerToken) {
    removeOwnedFile(filePath, expected.pid, expected.ownerToken);
    return;
  }
  try {
    const current = readPidFile(filePath);
    if (current?.pid === expected.pid && current.key === expected.key) fs.unlinkSync(filePath);
  } catch { /* best effort */ }
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
  } catch { /* best effort */ }
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
  } catch { /* best effort */ }
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
    } catch { /* best effort */ }
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
function acquireCoarseLock(baseDir: string, ownerToken: string): string {
  const lf = coarseStartLockPath(baseDir);
  ensurePrivateDir(path.dirname(lf));
  secureExistingFile(lf);
  clearStaleOwnership(lf, (pid) => new Error(`another daemon start is in progress on this machine (pid ${pid})`));
  writeExclusive(lf, { pid: process.pid, machineId: "coarse", startedAt: new Date().toISOString(), ownerToken });
  return lf;
}

function acquireLaunchLock(
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

function commitFinalPidfile(
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

function reconcileLegacyMachineKeyOwnership(baseDir: string, machineKey: string): void {
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

/* ------------------------------------------------------------------ */
/* daemon list                                                         */
/* ------------------------------------------------------------------ */

export interface DaemonListOpts {
  baseDir?: string;
}

export interface DaemonInfo {
  /**
   * The daemon's addressing id, shown to humans and passed to `daemon stop
   * <id>`. It is the server-issued machine id — NOT the machine key (a
   * credential that must never enter the human operation path). list shows it,
   * stop accepts it, so the two compose.
   */
  id: string;
  pid: number;
  alive: boolean;
  /**
   * Agent counts + last-activity ms-epoch from THIS daemon's own status.json
   * (`daemons/<id>/status.json`, per-daemon since C0). NULL when no snapshot yet
   * (or a dead daemon). Per-row accurate even with multiple daemons sharing a
   * baseDir (pre-C0 the global single file made every row show the last
   * writer's count). `running` = agents with derivedActivity "running" (actually
   * working a turn); `agents` = total registered — the render shows
   * `running/agents` so an operator sees "how many are busy" not just "how many
   * exist" (C2, the AGENTS-count-imprecision fix).
   */
  agents: number | null;
  running: number | null;
  lastActiveMs: number | null;
}

function daemonLastActiveMs(snapshot: DaemonStatusResult, nowMs: number): number | null {
  const writtenAt = snapshot.writtenAt;
  if (writtenAt == null || !Number.isFinite(writtenAt) || writtenAt < 0) return null;

  let latest: number | null = null;
  for (const agent of snapshot.agents) {
    const sinceProgressMs = agent.sinceProgressMs;
    if (!Number.isFinite(sinceProgressMs) || sinceProgressMs < 0) continue;
    const progressAt = writtenAt - sinceProgressMs;
    if (progressAt <= 0 || progressAt > nowMs) continue;
    latest = latest == null ? progressAt : Math.max(latest, progressAt);
  }
  return latest;
}

export function daemonList(opts: DaemonListOpts): DaemonInfo[] {
  const baseDir = opts.baseDir || process.env.ALOOK_DATA_DIR || DEFAULT_BASE_DIR;
  const dir = daemonsDir(baseDir);
  if (!fs.existsSync(dir)) return [];

  const results: DaemonInfo[] = [];
  const now = Date.now();

  const pushRow = (id: string, pidfile: string, statusPath: string | null): void => {
    const data = readPidFile(pidfile);
    if (!data) return;
    const alive = isProcessAlive(data.pid);
    if (!alive) {
      // Prune the stale pidfile (subdir daemon.pid or legacy flat).
      removePidFileIfMatches(pidfile, data);
    }
    // Per-daemon status: read THIS daemon's own snapshot (C0), not a global one.
    let agents: number | null = null;
    let running: number | null = null;
    let lastActiveMs: number | null = null;
    if (alive && statusPath) {
      const s = daemonStatusFromFile(statusPath, now);
      if (s.found) {
        agents = s.agents.length;
        running = s.agents.filter((a) => a.derivedActivity === "running").length;
        lastActiveMs = daemonLastActiveMs(s, now);
      }
    }
    results.push({ id, pid: data.pid, alive, agents, running, lastActiveMs });
  };

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    // Per-machine subdir layout: daemons/<id>/daemon.pid + status.json. Each
    // daemon has its own directory; id = the directory name.
    if (entry.isDirectory() && isDaemonId(entry.name)) {
      const id = entry.name;
      pushRow(id, path.join(dir, id, "daemon.pid"), path.join(dir, id, "status.json"));
    }
  }

  return results;
}

/* ------------------------------------------------------------------ */
/* daemon status                                                       */
/* ------------------------------------------------------------------ */

export interface DaemonStatusOpts {
  baseDir?: string;
  /**
   * Which daemon's status to read (the id from `daemon list`). Since C0 status
   * is per-daemon (`daemons/<id>/status.json`). If omitted and exactly ONE
   * daemon exists, that one is used; if omitted with multiple daemons it's
   * ambiguous → `ambiguous:true` (the CLI then tells the user to pass an id).
   */
  id?: string;
  /** Injectable clock for tests; defaults to Date.now. */
  now?: () => number;
}

export interface DaemonStatusResult {
  /** true if status.json was found and parsed. */
  found: boolean;
  /** ms since the snapshot was written (null if not found). */
  ageMs: number | null;
  /**
   * Freshness verdict: "fresh" (< a few write intervals), "stale" (older —
   * daemon may be paused/down; the frame is a last-known state), or "missing".
   * The CLI ALWAYS surfaces this so a stale snapshot is never mistaken for
   * live truth — an unflagged stale read would be exactly the "state unsynced"
   * blind spot this whole feature exists to kill.
   */
  freshness: "fresh" | "stale" | "missing";
  /** The snapshot's own writtenAt (ms epoch), or null. */
  writtenAt: number | null;
  agents: DaemonStatusSnapshot["agents"];
  /**
   * Set when no `id` was given AND more than one daemon exists — the caller must
   * disambiguate. `found` is false in that case (no single snapshot to return).
   */
  ambiguous?: boolean;
  /** The ids available to pass, when ambiguous. */
  availableIds?: string[];
}

/** Older than this ⇒ "stale" (a few status-write intervals of slack). */
const STATUS_STALE_MS = 20_000;

const MISSING_STATUS: DaemonStatusResult = { found: false, ageMs: null, freshness: "missing", writtenAt: null, agents: [] };

/** Read+parse ONE status.json at a known path. Never throws (best-effort). */
function daemonStatusFromFile(statusPath: string, nowMs: number): DaemonStatusResult {
  if (!fs.existsSync(statusPath)) return MISSING_STATUS;
  try {
    const snap = JSON.parse(fs.readFileSync(statusPath, "utf8")) as DaemonStatusSnapshot;
    const ageMs = nowMs - snap.writtenAt;
    return {
      found: true,
      ageMs,
      freshness: ageMs <= STATUS_STALE_MS ? "fresh" : "stale",
      writtenAt: snap.writtenAt,
      agents: Array.isArray(snap.agents) ? snap.agents : [],
    };
  } catch {
    // File present but unreadable/half-written/corrupt → treat as missing
    // rather than crash (a `daemon status` must never throw on a bad file).
    return MISSING_STATUS;
  }
}

/** The subdir ids of daemons that have a per-machine status file. */
function daemonIdsWithStatus(baseDir: string): string[] {
  const dir = daemonsDir(baseDir);
  if (!fs.existsSync(dir)) return [];
  const ids: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (
      entry.isDirectory() &&
      isDaemonId(entry.name) &&
      fs.existsSync(path.join(dir, entry.name, "status.json"))
    ) {
      ids.push(entry.name);
    }
  }
  return ids;
}

export function daemonStatus(opts: DaemonStatusOpts): DaemonStatusResult {
  const baseDir = opts.baseDir || process.env.ALOOK_DATA_DIR || DEFAULT_BASE_DIR;
  const nowMs = (opts.now ?? (() => Date.now()))();
  // Explicit id → that daemon's per-machine status.
  if (opts.id) {
    return daemonStatusFromFile(statusFilePathById(baseDir, opts.id), nowMs);
  }
  // No id: auto-pick the sole daemon; ambiguous if more than one.
  const ids = daemonIdsWithStatus(baseDir);
  if (ids.length === 1) {
    return daemonStatusFromFile(statusFilePathById(baseDir, ids[0]!), nowMs);
  }
  if (ids.length > 1) {
    return { ...MISSING_STATUS, ambiguous: true, availableIds: ids };
  }
  return MISSING_STATUS;
}

/* ------------------------------------------------------------------ */
/* daemon stop                                                         */
/* ------------------------------------------------------------------ */

export interface DaemonStopOpts {
  /** The id shown in `daemon list` (= the daemon's machine-id subdir name). */
  id: string;
  baseDir?: string;
}

/**
 * Core stop: SIGTERM → wait for the daemon's own ordered shutdown (stopAll
 * agent children, close channel/proxy, remove pidfile) → escalate to SIGKILL
 * only if it overruns the grace window. This kill/teardown semantic is
 * UNCHANGED by stop-by-id (plans/daemon-cli-humanize-charter.md red line 3) —
 * only HOW the daemon is addressed changed (its list id, not a machine key).
 */
async function stopExactPid(pid: number): Promise<void> {
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

async function stopByPidfile(pf: string, notFoundHint: string): Promise<void> {
  const data = readPidFile(pf);

  if (!data) {
    log.info(notFoundHint);
    return;
  }
  if (!isProcessAlive(data.pid)) {
    log.info(`stale pidfile (pid ${data.pid} is not running) — removing`);
    removePidFileIfMatches(pf, data);
    return;
  }

  log.info(`sending SIGTERM to daemon (pid ${data.pid})…`);
  await stopExactPid(data.pid);
  log.info("daemon stopped");
  removePidFileIfMatches(pf, data);
}

export async function daemonStop(opts: DaemonStopOpts): Promise<void> {
  const baseDir = opts.baseDir || process.env.ALOOK_DATA_DIR || DEFAULT_BASE_DIR;
  // Stop by the id `daemon list` shows — it IS the daemon's subdir name, so it
  // resolves the pidfile directly. The machine key (a credential) never enters
  // the human's stop command (red line 2): `daemon stop <id>`.
  await stopByPidfile(
    path.join(daemonDirById(baseDir, opts.id), "daemon.pid"),
    `no daemon with id '${opts.id}' (pidfile not found — check \`alook daemon list\`)`,
  );
}

/* ------------------------------------------------------------------ */
/* daemon start                                                        */
/* ------------------------------------------------------------------ */

export interface DaemonStartOpts {
  machineKey: string;
  serverUrl?: string;
  wsUrl?: string;
  baseDir?: string;
  foreground?: boolean;
  /** Internal-only replacement lock bypass. Never exposed on normal start. */
  resumeRequestId?: string;
  /** Internal reconnect guard sent to /activate before any credential rotate. */
  expectedMachineId?: string;
  /** Internal reconnect state hook; never logs or exposes the pairing token. */
  onActivationAttempt?: () => void;
}

export interface DaemonReconnectOpts {
  id: string;
  machineKey: string;
  serverUrl?: string;
  wsUrl?: string;
  baseDir?: string;
}

export interface DaemonReconnectDeps {
  isProcessAlive?: (pid: number) => boolean;
  stopExactDaemonPid?: (pid: number) => Promise<void>;
  start?: typeof daemonStart;
  resume?: typeof daemonResume;
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

function readCredentialFile(filePath: string): (DaemonLaunchRecord | { credential: string; machineId: string }) | null {
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

function writeCredentialFile(filePath: string, record: DaemonLaunchRecord): void {
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
function findExistingCredentialForBearer(
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

/**
 * Exchange a pending `cmt_` pairing token for a long-lived `cmk_` credential
 * via POST /api/community/daemon/activate. On success returns the credential
 * and machineId (used to name the on-disk credential file); on failure
 * surfaces the server's error message.
 */
async function activatePairingToken(
  serverUrl: string,
  tokenId: string,
  hostname: string,
  platform: string,
  arch: string,
  osRelease: string,
  daemonVersion: string,
  runtimeReport: Array<{ id: string; version?: string; status?: "healthy" | "unhealthy"; lastError?: string; lastErrorAt?: string }>,
  expectedMachineId?: string,
): Promise<{ credential: string; machineId: string }> {
  let res: Response;
  let json: unknown;
  let timedOut = false;
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, PAIRING_ACTIVATION_TIMEOUT_MS);
  timeout.unref?.();
  try {
    res = await fetch(`${serverUrl}/api/community/daemon/activate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${tokenId}`,
      },
      body: JSON.stringify({
        hostname,
        platform,
        arch,
        osRelease,
        daemonVersion,
        runtimeReport,
        ...(expectedMachineId ? { expectedMachineId } : {}),
      }),
      signal: controller.signal,
    });
    json = await res.json().catch(() => null);
  } catch (error) {
    throw new PairingActivationError(
      timedOut
        ? "activation timed out before commit status was known"
        : error instanceof Error ? error.message : String(error),
      "unknown",
    );
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) {
    const parsed = CommunityDaemonActivateErrorResponseSchema.safeParse(json);
    throw new PairingActivationError(
      parsed.success ? parsed.data.error : `activate failed (${res.status})`,
      res.status >= 400 && res.status < 500 && parsed.success
        ? parsed.data.sessionOutcome
        : "unknown",
    );
  }
  const parsed = CommunityDaemonActivateResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new PairingActivationError("activate returned an invalid response", "unknown");
  }
  return { credential: parsed.data.credential, machineId: parsed.data.machineId };
}

class PairingActivationError extends Error {
  constructor(
    message: string,
    readonly sessionOutcome: "not_committed" | "unknown",
  ) {
    super(message);
    this.name = "PairingActivationError";
  }
}

async function resolveMachineIdentity(serverUrl: string, credential: string): Promise<string> {
  const response = await fetch(`${serverUrl}/api/community/daemon/identity`, {
    headers: { authorization: `Bearer ${credential}` },
  });
  const body = await response.json().catch(() => ({})) as { machineId?: string; error?: string };
  if (!response.ok || typeof body.machineId !== "string" || body.machineId.length === 0) {
    throw new Error(body.error ?? `identity failed (${response.status})`);
  }
  return body.machineId;
}

interface PreparedStart {
  prepared: PreparedDaemon;
  launchLockPath: string;
}

async function prepareDaemonStart(opts: DaemonStartOpts): Promise<PreparedStart> {
  const serverUrl = opts.serverUrl || process.env.ALOOK_SERVER_URL || DEFAULT_SERVER_URL;
  const wsUrl = opts.wsUrl || process.env.ALOOK_SERVER_WS_URL || DEFAULT_WS_URL;
  if (!opts.machineKey.startsWith("cmt_") && !opts.machineKey.startsWith("cmk_")) {
    throw new Error("invalid machine key format — expected `cmt_` or `cmk_`");
  }
  const baseDir = opts.baseDir || process.env.ALOOK_DATA_DIR || DEFAULT_BASE_DIR;
  const daemonVersion = readDaemonVersion();
  if (!parseReleaseVersion(daemonVersion)) throw new Error("daemon package version is not a strict release version");
  const ownerToken = crypto.randomBytes(24).toString("base64url");
  const persisted = opts.machineKey.startsWith("cmk_")
    ? findExistingCredentialForBearer(baseDir, opts.machineKey)
    : null;
  const reconnectMachineId = opts.machineKey.startsWith("cmt_")
    && opts.expectedMachineId
    && opts.resumeRequestId
    ? validateMachineId(opts.expectedMachineId)
    : undefined;
  let coarseLockPath: string | null = null;
  let launchLockPath: string | null = null;
  try {
    let machineKey = persisted?.credential;
    let machineId = persisted
      ? validateMachineId(persisted.machineId)
      : reconnectMachineId;
    if (machineId) {
      launchLockPath = acquireLaunchLock(baseDir, machineId, ownerToken, opts.resumeRequestId);
    } else {
      coarseLockPath = acquireCoarseLock(baseDir, ownerToken);
      if (opts.machineKey.startsWith("cmk_")) {
        reconcileLegacyMachineKeyOwnership(baseDir, opts.machineKey);
      }
    }
    const runtimeReport: RuntimeInfo[] = await detectRuntimes();
    const healthyRuntimeIds = runtimeReport
      .filter((runtime) => runtime.status === "healthy")
      .map((runtime) => runtime.id);
    if (opts.machineKey.startsWith("cmt_")) {
      opts.onActivationAttempt?.();
      const activated = await activatePairingToken(
        serverUrl,
        opts.machineKey,
        os.hostname(),
        process.platform,
        process.arch,
        os.release(),
        daemonVersion,
        runtimeReport,
        opts.expectedMachineId,
      );
      machineKey = activated.credential;
      machineId = validateMachineId(activated.machineId);
      if (
        opts.expectedMachineId &&
        machineId !== validateMachineId(opts.expectedMachineId)
      ) {
        throw new Error("activate returned a different machine identity");
      }
    } else {
      machineKey ??= opts.machineKey;
      machineId ??= validateMachineId(await resolveMachineIdentity(serverUrl, opts.machineKey));
    }
    launchLockPath ??= acquireLaunchLock(baseDir, machineId, ownerToken, opts.resumeRequestId);
    writeCredentialFile(credentialFilePathByMachineId(baseDir, machineId), {
      schemaVersion: 1,
      credential: machineKey,
      machineId,
      serverUrl,
      wsUrl,
      daemonVersion,
    });
    if (
      process.env.NODE_ENV === "test" &&
      process.env.ALOOK_DAEMON_TEST_FAIL_AFTER_ACTIVATE === "1" &&
      opts.expectedMachineId
    ) {
      throw new Error("test-gated daemon start failure after activation");
    }
    if (coarseLockPath) removeOwnedFile(coarseLockPath, process.pid, ownerToken);
    const startedAt = new Date().toISOString();
    return {
      launchLockPath,
      prepared: {
        machineId,
        machineKey,
        serverUrl,
        wsUrl,
        baseDir,
        daemonDir: daemonDirById(baseDir, machineId),
        statusFilePath: statusFilePathById(baseDir, machineId),
        agentCliPath: resolveAlookCliPathWithFallback() ?? process.argv[1],
        runtimeReport,
        healthyRuntimeIds,
        hostname: os.hostname(),
        platform: process.platform,
        arch: process.arch,
        osRelease: os.release(),
        daemonVersion,
        ownerToken,
        startedAt,
      },
    };
  } catch (error) {
    if (launchLockPath) removeOwnedFile(launchLockPath, process.pid, ownerToken);
    if (coarseLockPath) removeOwnedFile(coarseLockPath, process.pid, ownerToken);
    throw error;
  }
}

export async function daemonResume(opts: {
  id: string;
  baseDir?: string;
  requestId: string;
}): Promise<void> {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(opts.requestId)) throw new Error("invalid replacement request id");
  const baseDir = opts.baseDir || process.env.ALOOK_DATA_DIR || DEFAULT_BASE_DIR;
  const record = readDaemonLaunchRecord(baseDir, opts.id);
  if (
    process.env.NODE_ENV === "test"
    && fs.existsSync(path.join(daemonDirById(baseDir, opts.id), `test-fail-start-${readDaemonVersion()}`))
  ) {
    throw new Error("test-gated daemon resume failure");
  }
  await daemonStart({
    machineKey: record.credential,
    serverUrl: record.serverUrl,
    wsUrl: record.wsUrl,
    baseDir,
    resumeRequestId: opts.requestId,
  });
}

export async function daemonStartById(opts: {
  id: string;
  baseDir?: string;
  foreground?: boolean;
}): Promise<void> {
  const baseDir = opts.baseDir || process.env.ALOOK_DATA_DIR || DEFAULT_BASE_DIR;
  const record = readDaemonLaunchRecord(baseDir, opts.id);
  await daemonStart({
    machineKey: record.credential,
    serverUrl: record.serverUrl,
    wsUrl: record.wsUrl,
    baseDir,
    foreground: opts.foreground,
  });
}

function pidOwnershipEqual(a: DaemonPidFile | null, b: DaemonPidFile | null): boolean {
  if (!a || !b) return a === b;
  return a.pid === b.pid
    && a.machineId === b.machineId
    && a.startedAt === b.startedAt
    && a.ownerToken === b.ownerToken;
}

/**
 * Exact-machine reconnect. Replacement ownership is acquired before the old
 * PID is touched and held through activation plus replacement readiness.
 */
export async function daemonReconnect(
  opts: DaemonReconnectOpts,
  deps: DaemonReconnectDeps = {},
): Promise<void> {
  if (!opts.machineKey.startsWith("cmt_")) {
    throw new Error("daemon reconnect requires a cmt_ pairing token");
  }
  const machineId = validateMachineId(opts.id);
  const baseDir = opts.baseDir || process.env.ALOOK_DATA_DIR || DEFAULT_BASE_DIR;
  const launch = readDaemonLaunchRecord(baseDir, machineId);
  const pidPath = pidfilePathById(baseDir, machineId);
  const before = readPidFile(pidPath);
  if (
    before &&
    (before.machineId !== machineId || !before.startedAt || !before.ownerToken)
  ) {
    throw new Error("daemon reconnect cannot verify the current pid ownership tuple");
  }

  const requestId = crypto.randomUUID();
  const replacement = acquireDaemonReplacementLock({ baseDir, machineId, requestId });
  let oldStopped = false;
  let activationAttempted = false;
  try {
    const owned = readPidFile(pidPath);
    if (!pidOwnershipEqual(before, owned)) {
      throw new Error("daemon ownership changed after reconnect lock acquisition");
    }
    if (owned && (deps.isProcessAlive ?? isProcessAlive)(owned.pid)) {
      await (deps.stopExactDaemonPid ?? stopExactDaemonPid)(owned.pid);
      oldStopped = true;
      removePidFileIfMatches(pidPath, owned);
    } else if (owned) {
      removePidFileIfMatches(pidPath, owned);
    }

    try {
      await (deps.start ?? daemonStart)({
        machineKey: opts.machineKey,
        serverUrl: opts.serverUrl ?? launch.serverUrl,
        wsUrl: opts.wsUrl ?? launch.wsUrl,
        baseDir,
        resumeRequestId: requestId,
        expectedMachineId: machineId,
        onActivationAttempt: () => { activationAttempted = true; },
      });
    } catch (error) {
      const canRestoreOldEpoch = !activationAttempted
        || (error instanceof PairingActivationError && error.sessionOutcome === "not_committed");
      if (oldStopped && canRestoreOldEpoch) {
        try {
          await (deps.resume ?? daemonResume)({ id: machineId, baseDir, requestId });
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            "reconnect failed before rotation and the prior daemon could not be resumed",
          );
        }
      }
      throw error;
    }
  } finally {
    removeReplacementLockIfMatches(replacement.path, replacement.lock);
  }
}

function runnerArguments(): string[] {
  const command = process.env.ALOOK_DAEMON_PACKAGE_WRAPPER === "1" ? ["run"] : ["daemon", "run"];
  return [...process.execArgv, process.argv[1]!, ...command];
}

function spawnBlockedRunner(): ChildProcess {
  return spawn(process.execPath, runnerArguments(), {
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
}

function testCheckpoint(name: string, childPid: number): void {
  if (process.env.NODE_ENV !== "test" || process.env.ALOOK_DAEMON_TEST_PAUSE_AT !== name) return;
  const checkpointFile = process.env.ALOOK_DAEMON_TEST_CHECKPOINT_FILE;
  if (!checkpointFile) return;
  fs.writeFileSync(checkpointFile, JSON.stringify({ name, parentPid: process.pid, childPid }), { mode: 0o600 });
  const view = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(`${checkpointFile}.continue`)) Atomics.wait(view, 0, 0, 25);
}

function sendPrepared(child: ChildProcess, prepared: PreparedDaemon): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!child.send) {
      reject(new Error("daemon child has no IPC channel"));
      return;
    }
    child.send({ type: "daemon:prepared", prepared }, (error) => error ? reject(error) : resolve());
  });
}

function waitForReceipt(child: ChildProcess, prepared: PreparedDaemon): Promise<DaemonReadyReceipt> {
  return new Promise((resolve, reject) => {
    const settle = (error?: Error, receipt?: DaemonReadyReceipt): void => {
      clearTimeout(timeout);
      child.removeAllListeners("message");
      child.removeAllListeners("exit");
      child.removeAllListeners("error");
      if (error) reject(error);
      else resolve(receipt!);
    };
    const configuredTestTimeout = process.env.NODE_ENV === "test"
      ? Number(process.env.ALOOK_DAEMON_TEST_RECEIPT_TIMEOUT_MS)
      : NaN;
    const receiptTimeoutMs = Number.isFinite(configuredTestTimeout) && configuredTestTimeout > 0
      ? configuredTestTimeout
      : START_RECEIPT_TIMEOUT_MS;
    const timeout = setTimeout(
      () => settle(new Error(`daemon start timed out; inspect ${path.join(prepared.daemonDir, "daemon.log")}`)),
      receiptTimeoutMs,
    );
    child.on("message", (message: unknown) => {
      const accepted = message as { type?: string; pid?: number; machineId?: string };
      if (accepted.type === "daemon:accepted") {
        if (accepted.pid !== child.pid || accepted.machineId !== prepared.machineId) {
          settle(new Error("daemon child returned an invalid prepared acknowledgment"));
          return;
        }
        testCheckpoint("after_ipc_send", child.pid!);
        return;
      }
      const receipt = message as DaemonReadyReceipt;
      if (receipt?.pid !== child.pid || receipt.machineId !== prepared.machineId || receipt.startedAt !== prepared.startedAt) {
        settle(new Error("daemon child returned an invalid start receipt"));
        return;
      }
      settle(undefined, receipt);
    });
    child.once("exit", (code, signal) => {
      settle(new Error(`daemon child exited before ready (${signal ?? code}); inspect ${path.join(prepared.daemonDir, "daemon.log")}`));
    });
    child.once("error", (error) => settle(error));
  });
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (exited: boolean): void => {
      clearTimeout(timeout);
      child.removeListener("exit", onExit);
      resolve(exited);
    };
    const onExit = (): void => finish(true);
    const timeout = setTimeout(() => finish(child.exitCode !== null || child.signalCode !== null), timeoutMs);
    child.once("exit", onExit);
    if (child.exitCode !== null || child.signalCode !== null) finish(true);
  });
}

async function terminateRunnerAndWait(child: ChildProcess): Promise<void> {
  try { child.kill("SIGTERM"); } catch { /* exit observation below is authoritative */ }
  if (await waitForChildExit(child, RUNNER_TERM_GRACE_MS)) return;
  try { child.kill("SIGKILL"); } catch { /* exit observation below is authoritative */ }
  if (await waitForChildExit(child, RUNNER_KILL_GRACE_MS)) return;
  throw new Error(`daemon child ${child.pid ?? "unknown"} did not exit after SIGKILL`);
}

export async function daemonStart(opts: DaemonStartOpts): Promise<void> {
  const { prepared, launchLockPath } = await prepareDaemonStart(opts);
  const finalPidfile = pidfilePathById(prepared.baseDir, prepared.machineId);
  if (opts.foreground) {
    try {
      commitFinalPidfile(prepared.baseDir, prepared.machineId, process.pid, prepared.startedAt, prepared.ownerToken);
      return await runPreparedDaemon(prepared, {
        foreground: true,
        onReady: () => removeOwnedFile(launchLockPath, process.pid, prepared.ownerToken),
        releaseOwnership: () => removeOwnedFile(finalPidfile, process.pid, prepared.ownerToken),
      });
    } finally {
      removeOwnedFile(finalPidfile, process.pid, prepared.ownerToken);
      removeOwnedFile(launchLockPath, process.pid, prepared.ownerToken);
    }
  }

  const child = spawnBlockedRunner();
  if (!child.pid) {
    removeOwnedFile(launchLockPath, process.pid, prepared.ownerToken);
    throw new Error("failed to spawn daemon child");
  }
  try {
    testCheckpoint("after_spawn_before_final", child.pid);
    commitFinalPidfile(prepared.baseDir, prepared.machineId, child.pid, prepared.startedAt, prepared.ownerToken);
    testCheckpoint("after_final_before_ipc", child.pid);
    const receiptPromise = waitForReceipt(child, prepared);
    await sendPrepared(child, prepared);
    const receipt = await receiptPromise;
    removeOwnedFile(launchLockPath, process.pid, prepared.ownerToken);
    child.unref();
    log.info(`daemon started in background (pid ${receipt.pid}); log ${receipt.logPath}`);
  } catch (error) {
    await terminateRunnerAndWait(child);
    removeOwnedFile(finalPidfile, child.pid, prepared.ownerToken);
    removeOwnedFile(launchLockPath, process.pid, prepared.ownerToken);
    throw error;
  }
}

export async function daemonRunFromIpc(ipc: typeof process = process): Promise<never> {
  if (typeof ipc.send !== "function") throw new Error("daemon run requires parent IPC");
  if (!ipc.connected) throw new Error("daemon parent disconnected before prepared payload");
  return await new Promise<never>((_resolve, reject) => {
    let received = false;
    ipc.once("disconnect", () => {
      if (!received) reject(new Error("daemon parent disconnected before prepared payload"));
    });
    ipc.once("message", (message: unknown) => {
      received = true;
      const payload = message as { type?: string; prepared?: PreparedDaemon };
      const prepared = payload.prepared;
      payload.prepared = undefined;
      if (payload.type !== "daemon:prepared" || !prepared) {
        reject(new Error("invalid daemon prepared payload"));
        return;
      }
      const finalPidfile = pidfilePathById(prepared.baseDir, prepared.machineId);
      const owner = readPidFile(finalPidfile);
      if (owner?.pid !== ipc.pid || owner.machineId !== prepared.machineId || owner.ownerToken !== prepared.ownerToken) {
        reject(new Error("daemon ownership validation failed"));
        return;
      }
      sendIpcBestEffort(ipc, { type: "daemon:accepted", pid: ipc.pid, machineId: prepared.machineId });
      void runPreparedDaemon(prepared, {
        foreground: false,
        onReady: (receipt) => {
          if (process.env.NODE_ENV === "test" && process.env.ALOOK_DAEMON_TEST_SKIP_READY === "1") return;
          sendIpcBestEffort(ipc, receipt, true);
        },
        releaseOwnership: () => {
          const marker = process.env.ALOOK_DAEMON_TEST_RELEASE_MARKER;
          if (process.env.NODE_ENV === "test" && marker) fs.appendFileSync(marker, `${ipc.pid}\n`, { mode: 0o600 });
          removeOwnedFile(finalPidfile, ipc.pid, prepared.ownerToken);
        },
      }).catch(reject);
    });
  });
}

function sendIpcBestEffort(ipc: typeof process, message: unknown, disconnectAfter = false): void {
  if (!ipc.connected || typeof ipc.send !== "function") return;
  const disconnect = (): void => {
    if (!disconnectAfter) return;
    try { ipc.disconnect?.(); } catch { /* parent notification is best effort */ }
  };
  try {
    ipc.send(message, () => disconnect());
  } catch {
    disconnect();
  }
}
