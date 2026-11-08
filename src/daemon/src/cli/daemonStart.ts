import { DEFAULT_BASE_DIR, daemonsDir, daemonDirById, validateMachineId, isDaemonId, pidfilePathById, statusFilePathById, isProcessAlive, readPidFile, removeOwnedFile, removePidFileIfMatches, removeReplacementLockIfMatches, acquireDaemonReplacementLock, acquireCoarseLock, acquireLaunchLock, commitFinalPidfile, reconcileLegacyMachineKeyOwnership, stopExactPid, stopExactDaemonPid, credentialFilePathByMachineId, readCredentialFile, writeCredentialFile, readDaemonLaunchRecord, findExistingCredentialForBearer, daemonProcessArguments } from "./daemonState.js";

import { sameDaemonOwnership } from "./daemonOwnership.js";
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

import type { DaemonStatusSnapshot } from "../util/statusFile.js";
import { resolveAlookCliPathWithFallback, detectRuntimes, type RuntimeInfo } from "../discovery.js";
import { createLogger } from "../logger.js";
import { readDaemonVersion } from "../version.js";
import { withoutNpmExecPackage } from "../npmEnvironment.js";
import { runPreparedDaemon, type DaemonReadyReceipt, type PreparedDaemon } from "./daemonRunner.js";
import { spawn, type ChildProcess } from "node:child_process";
import {
  CommunityDaemonActivateErrorResponseSchema,
  CommunityDaemonActivateResponseSchema,
  parseReleaseVersion,
} from "@alook/shared";
const START_RECEIPT_TIMEOUT_MS = 15_000;
const PAIRING_ACTIVATION_TIMEOUT_MS = 30_000;
const RUNNER_TERM_GRACE_MS = 2_000;
const RUNNER_KILL_GRACE_MS = 2_000;
const DEFAULT_SERVER_URL = "https://alook.ai";
const DEFAULT_WS_URL = "wss://alook.ai/api/ws/community-daemon";

const log = createLogger({ header: "@alook/daemon" });

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
   * writer's count). Current daemons publish `running` from the process
   * manager's owned sessions and `agents` from the machine-scoped bound-bot
   * roster; older snapshots retain the FSM-row fallback for compatibility.
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

      removePidFileIfMatches(pidfile, data);
    }

    let agents: number | null = null;
    let running: number | null = null;
    let lastActiveMs: number | null = null;
    if (alive && statusPath) {
      const s = daemonStatusFromFile(statusPath, now);
      if (s.found) {
        if (s.agentSummary) {
          agents = s.agentSummary.total;
          running = s.agentSummary.running;
        } else {
          // Compatibility with snapshots written by older daemons.
          agents = s.agents.length;
          running = s.agents.filter((a) => a.derivedActivity === "running").length;
        }
        lastActiveMs = daemonLastActiveMs(s, now);
      }
    }
    results.push({ id, pid: data.pid, alive, agents, running, lastActiveMs });
  };

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {

    if (entry.isDirectory() && isDaemonId(entry.name)) {
      const id = entry.name;
      pushRow(id, path.join(dir, id, "daemon.pid"), path.join(dir, id, "status.json"));
    }
  }

  return results;
}

export interface DaemonStatusOpts {
  baseDir?: string;
  /**
   * Which daemon's status to read (the id from `daemon list`). Since C0 status
   * is per-daemon (`daemons/<id>/status.json`). If omitted and exactly ONE
   * daemon exists, that one is used; if omitted with multiple daemons it's
   * ambiguous → `ambiguous:true` (the CLI then tells the user to pass an id).
   */
  id?: string;

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
  /** Authoritative list counts when written by a current daemon. */
  agentSummary: DaemonStatusSnapshot["agentSummary"] | null;
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

const MISSING_STATUS: DaemonStatusResult = {
  found: false,
  ageMs: null,
  freshness: "missing",
  writtenAt: null,
  agentSummary: null,
  agents: [],
};

function validAgentSummary(value: unknown): DaemonStatusSnapshot["agentSummary"] | null {
  if (!value || typeof value !== "object") return null;
  const summary = value as { total?: unknown; running?: unknown };
  const validTotal = summary.total === null
    || (Number.isInteger(summary.total) && (summary.total as number) >= 0);
  const validRunning = Number.isInteger(summary.running) && (summary.running as number) >= 0;
  if (!validTotal || !validRunning) return null;
  return { total: summary.total as number | null, running: summary.running as number };
}

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
      agentSummary: validAgentSummary(snap.agentSummary),
      agents: Array.isArray(snap.agents) ? snap.agents : [],
    };
  } catch {
    // File present but unreadable/half-written/corrupt → treat as missing
    // rather than crash (a `daemon status` must never throw on a bad file).
    return MISSING_STATUS;
  }
}

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

  if (opts.id) {
    return daemonStatusFromFile(statusFilePathById(baseDir, opts.id), nowMs);
  }

  const ids = daemonIdsWithStatus(baseDir);
  if (ids.length === 1) {
    return daemonStatusFromFile(statusFilePathById(baseDir, ids[0]!), nowMs);
  }
  if (ids.length > 1) {
    return { ...MISSING_STATUS, ambiguous: true, availableIds: ids };
  }
  return MISSING_STATUS;
}

export interface DaemonStopOpts {
  /** The id shown in `daemon list` (= the daemon's machine-id subdir name). */
  id: string;
  baseDir?: string;
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
  runtimeReport: RuntimeInfo[],
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
  const launch = readCredentialFile(credentialFilePathByMachineId(baseDir, machineId));
  if (launch && launch.machineId !== machineId) throw new Error("daemon launch record machine mismatch");
  const serverUrl = opts.serverUrl ?? (launch && "serverUrl" in launch ? launch.serverUrl : undefined);
  const wsUrl = opts.wsUrl ?? (launch && "wsUrl" in launch ? launch.wsUrl : undefined);
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
    if (!sameDaemonOwnership(before, owned)) {
      throw new Error("daemon ownership changed after reconnect lock acquisition");
    }
    if (owned && (deps.isProcessAlive ?? isProcessAlive)(owned.pid)) {
      if (!launch) {
        throw new Error(`cannot safely reconnect a running daemon without its saved credential; run daemon stop ${machineId}, then retry the reconnect command`);
      }
      await (deps.stopExactDaemonPid ?? stopExactDaemonPid)(owned.pid);
      oldStopped = true;
      removePidFileIfMatches(pidPath, owned);
    } else if (owned) {
      removePidFileIfMatches(pidPath, owned);
    }

    try {
      await (deps.start ?? daemonStart)({
        machineKey: opts.machineKey,
        serverUrl,
        wsUrl,
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
          if (deps.resume || (launch && "daemonVersion" in launch && parseReleaseVersion(launch.daemonVersion))) {
            await (deps.resume ?? daemonResume)({ id: machineId, baseDir, requestId });
          } else {
            await (deps.start ?? daemonStart)({
              machineKey: launch!.credential,
              serverUrl,
              wsUrl,
              baseDir,
              resumeRequestId: requestId,
            });
          }
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

function spawnBlockedRunner(): ChildProcess {
  return spawn(process.execPath, daemonProcessArguments("run"), {
    env: withoutNpmExecPackage(process.env),
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
