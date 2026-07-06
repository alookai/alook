/**
 * `alook daemon start|stop|list` — daemon lifecycle commands.
 *
 * Multiple daemons can run on one physical machine — each machine key represents
 * one logical machine on the server side. Per-key pidfiles at
 * `<baseDir>/daemons/<keyHash>.pid` prevent the same key from starting twice.
 */
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as os from "os";
import { homedir } from "os";
import { WebSocket } from "ws";
import { createRequire } from "module";
import { createDaemon } from "../daemon/createDaemon.js";
import { getDriver } from "../drivers/index.js";
import { resolveAlookCliPathWithFallback, detectRuntimes, type RuntimeInfo } from "../discovery.js";
import { createLogger } from "../logger.js";
import { UnknownRuntimeError } from "../manager/agentRouter.js";

const requireFromHere = createRequire(import.meta.url);
function readDaemonVersion(): string {
  try {
    const pkg = requireFromHere("../../package.json") as { version?: string };
    return pkg.version ?? "";
  } catch {
    return "";
  }
}

const CAPABILITIES = ["send", "read", "mentions", "tasks", "reactions", "server", "channels", "knowledge"];

function resolveDefaultBaseDir(): string {
  const root = process.env.ALOOK_PROJECT_ROOT || path.join(homedir(), ".alook");
  return path.join(root, "daemon");
}

export const DEFAULT_BASE_DIR = resolveDefaultBaseDir();

const log = createLogger({ header: "@alook/daemon" });

/* ------------------------------------------------------------------ */
/* Per-key pidfile helpers                                              */
/* ------------------------------------------------------------------ */

function keyHash(machineKey: string): string {
  return crypto.createHash("sha256").update(machineKey).digest("hex").slice(0, 12);
}

function daemonsDir(baseDir: string): string {
  return path.join(baseDir, "daemons");
}

function pidfilePath(baseDir: string, machineKey: string): string {
  return path.join(daemonsDir(baseDir), `${keyHash(machineKey)}.pid`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPidFile(filePath: string): { pid: number; key: string } | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const content = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (typeof content.pid === "number" && typeof content.key === "string") return content;
  } catch { /* malformed */ }
  return null;
}

function writePidFile(filePath: string, pid: number, machineKey: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ pid, key: machineKey }));
}

function acquireLock(baseDir: string, machineKey: string): string {
  const pf = pidfilePath(baseDir, machineKey);
  const existing = readPidFile(pf);
  if (existing && isProcessAlive(existing.pid)) {
    log.error(`daemon for this machine key already running (pid ${existing.pid}). Stop it first or remove ${pf}`);
    process.exit(1);
  }
  writePidFile(pf, process.pid, machineKey);
  return pf;
}

function releaseLock(pf: string): void {
  try {
    const content = readPidFile(pf);
    if (content && content.pid === process.pid) {
      fs.unlinkSync(pf);
    }
  } catch { /* best effort */ }
}

/* ------------------------------------------------------------------ */
/* daemon list                                                         */
/* ------------------------------------------------------------------ */

export interface DaemonListOpts {
  baseDir?: string;
}

export interface DaemonInfo {
  keyHash: string;
  keyPrefix: string;
  pid: number;
  alive: boolean;
}

export function daemonList(opts: DaemonListOpts): DaemonInfo[] {
  const baseDir = opts.baseDir || process.env.ALOOK_DATA_DIR || DEFAULT_BASE_DIR;
  const dir = daemonsDir(baseDir);
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".pid"));
  const results: DaemonInfo[] = [];

  for (const file of files) {
    const filePath = path.join(dir, file);
    const data = readPidFile(filePath);
    if (!data) continue;
    const alive = isProcessAlive(data.pid);
    // Clean up stale pidfiles
    if (!alive) {
      try { fs.unlinkSync(filePath); } catch { /* ok */ }
    }
    results.push({
      keyHash: file.replace(".pid", ""),
      keyPrefix: data.key.slice(0, 20) + "…",
      pid: data.pid,
      alive,
    });
  }

  return results;
}

/* ------------------------------------------------------------------ */
/* daemon stop                                                         */
/* ------------------------------------------------------------------ */

export interface DaemonStopOpts {
  machineKey: string;
  baseDir?: string;
}

export function daemonStop(opts: DaemonStopOpts): void {
  const baseDir = opts.baseDir || process.env.ALOOK_DATA_DIR || DEFAULT_BASE_DIR;
  const pf = pidfilePath(baseDir, opts.machineKey);
  const data = readPidFile(pf);

  if (!data) {
    log.info("no daemon running for this machine key (pidfile not found)");
    return;
  }
  if (!isProcessAlive(data.pid)) {
    log.info(`stale pidfile (pid ${data.pid} is not running) — removing`);
    try { fs.unlinkSync(pf); } catch { /* ok */ }
    return;
  }

  log.info(`sending SIGTERM to daemon (pid ${data.pid})…`);
  process.kill(data.pid, "SIGTERM");

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && isProcessAlive(data.pid)) {
    const start = Date.now();
    while (Date.now() - start < 100) { /* spin */ }
  }

  if (isProcessAlive(data.pid)) {
    log.error(`daemon (pid ${data.pid}) did not exit in 5s — sending SIGKILL`);
    process.kill(data.pid, "SIGKILL");
  } else {
    log.info("daemon stopped");
  }
  try { fs.unlinkSync(pf); } catch { /* ok */ }
}

/* ------------------------------------------------------------------ */
/* daemon start                                                        */
/* ------------------------------------------------------------------ */

export interface DaemonStartOpts {
  machineKey: string;
  serverUrl?: string;
  wsUrl?: string;
  baseDir?: string;
}

/**
 * Path to the persisted `cmk_` credential file for a paired machine.
 * Derived from the server-supplied `machineId` (stable across credential
 * rotates), so the file self-overwrites on reconnect and no orphaned 0600
 * files accumulate on disk.
 */
export function credentialFilePathByMachineId(baseDir: string, machineId: string): string {
  return path.join(daemonsDir(baseDir), `${machineId}.credential.json`);
}

/** Legacy accessor kept for the boot-time index scan; not used to write. */
function credentialFilesDir(baseDir: string): string {
  return daemonsDir(baseDir);
}

function readCredentialFile(filePath: string): { credential: string; machineId: string } | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const content = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (
      typeof content.credential === "string" &&
      content.credential.startsWith("cmk_") &&
      typeof content.machineId === "string"
    ) {
      return { credential: content.credential, machineId: content.machineId };
    }
  } catch { /* malformed */ }
  return null;
}

function writeCredentialFile(filePath: string, credential: string, machineId: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ credential, machineId }), { mode: 0o600 });
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
  const dir = credentialFilesDir(baseDir);
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
): Promise<{ credential: string; machineId: string }> {
  const res = await fetch(`${serverUrl}/api/community/daemon/activate`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${tokenId}`,
    },
    body: JSON.stringify({ hostname, platform, arch, osRelease, daemonVersion, runtimeReport }),
  });
  const json = (await res.json().catch(() => ({}))) as {
    credential?: string;
    machineId?: string;
    error?: string;
  };
  if (!res.ok || !json.credential || !json.machineId) {
    throw new Error(json.error ?? `activate failed (${res.status})`);
  }
  return { credential: json.credential, machineId: json.machineId };
}

export async function daemonStart(opts: DaemonStartOpts): Promise<void> {
  const serverUrl = opts.serverUrl || process.env.ALOOK_SERVER_URL;
  const wsUrl = opts.wsUrl || process.env.ALOOK_SERVER_WS_URL;

  if (!serverUrl) {
    log.error("Server URL required — pass --server-url or set ALOOK_SERVER_URL");
    process.exit(2);
  }
  if (!wsUrl) {
    log.error("WebSocket URL required — pass --ws-url or set ALOOK_SERVER_WS_URL");
    process.exit(2);
  }

  const baseDir = opts.baseDir || process.env.ALOOK_DATA_DIR || DEFAULT_BASE_DIR;
  const pf = acquireLock(baseDir, opts.machineKey);

  const agentCliPath = resolveAlookCliPathWithFallback() ?? process.argv[1];

  // Detect installed agent CLIs. The list is reported to the server on
  // `ready` so the machine card can show a chip per CLI (with version).
  // We report EVERY runtime we know about (healthy AND unhealthy) so the
  // /community machine card can surface broken installs, not just missing
  // ones. Filtering to healthy-only happens on the reader side (bot picker,
  // server-side bots-POST validator).
  const runtimeDetections: RuntimeInfo[] = await detectRuntimes();
  const healthyRuntimeIds = runtimeDetections.filter((r) => r.status === "healthy").map((r) => r.id);
  log.info(
    healthyRuntimeIds.length === 0
      ? "no agent CLIs detected"
      : `detected agent CLIs: ${healthyRuntimeIds.join(", ")}`
  );
  const unhealthyIds = runtimeDetections
    .filter((r) => r.status === "unhealthy")
    .map((r) => `${r.id}(${r.lastError ?? "unknown"})`);
  if (unhealthyIds.length > 0) log.info(`unhealthy runtimes: ${unhealthyIds.join(", ")}`);

  const runtimeReport = runtimeDetections.map((r) => ({
    id: r.id,
    version: r.version,
    status: r.status,
    lastError: r.lastError,
    lastErrorAt: r.lastErrorAt,
  }));

  // Resolve the actual credential the daemon will dial with. Ordering:
  //   1. --machine-key starts with `cmt_` — POST /activate, get {cmk_, machineId},
  //      write file at <daemonsDir>/<machineId>.credential.json.
  //   2. --machine-key starts with `cmk_` — scan on-disk credential files for
  //      one whose stored credential matches; if found, reuse. Otherwise this
  //      is a fresh paste with no machineId to key the file on — dial with
  //      the plaintext but skip persistence until the server confirms
  //      identity on the next boot.
  //   3. else → exit(2) "invalid machine key format".
  let dialingCredential: string;
  if (opts.machineKey.startsWith("cmt_")) {
    log.info("activating pairing token…");
    try {
      const activated = await activatePairingToken(
        serverUrl,
        opts.machineKey,
        os.hostname(),
        process.platform,
        process.arch,
        os.release(),
        readDaemonVersion(),
        runtimeReport,
      );
      dialingCredential = activated.credential;
      writeCredentialFile(
        credentialFilePathByMachineId(baseDir, activated.machineId),
        dialingCredential,
        activated.machineId
      );
      log.info("pairing token activated — credential persisted");
    } catch (err) {
      log.error(`activation failed: ${err instanceof Error ? err.message : String(err)}`);
      releaseLock(pf);
      process.exit(1);
    }
  } else if (opts.machineKey.startsWith("cmk_")) {
    const match = findExistingCredentialForBearer(baseDir, opts.machineKey);
    if (match) {
      dialingCredential = match.credential;
      log.info("using persisted daemon credential");
    } else {
      // No file → dial with the pasted credential; if it works the server
      // owns identity anyway. We don't persist since we can't derive the
      // filename without machineId.
      dialingCredential = opts.machineKey;
      log.info("dialing with provided cmk_ (no on-disk record)");
    }
  } else {
    log.error("invalid machine key format — expected `cmt_` (pairing token) or `cmk_` (credential)");
    releaseLock(pf);
    process.exit(2);
  }

  const daemon = await createDaemon({
    machineKey: dialingCredential,
    serverUrl,
    serverWsUrl: wsUrl,
    webSocketFactory: (url, headers) => new WebSocket(url, { headers }),
    runtimeReport,
    // Pick the driver for the runtime the agent actually asked for. The
    // request is a hard requirement — if the runtime isn't detected on this
    // host we throw `UnknownRuntimeError`, which `agentRouter` catches and
    // forwards to the server as a `session.error{code:"runtime_not_available"}`
    // so the machine card surfaces the mismatch instead of silently launching
    // a different runtime.
    // driverFor throws UnknownRuntimeError for a runtime the daemon does not
    // know about at all. The router additionally short-circuits dispatch when
    // a KNOWN runtime is currently unhealthy — see AgentRouter wiring in
    // createDaemon. Both throws land in the same catch block in agentRouter
    // and surface as bot_runtime_missing + runtime_not_available.
    driverFor: (_agentId, runtimeConfig) => {
      const requested = runtimeConfig?.runtime;
      const known: string[] = runtimeReport.map((r) => r.id);
      if (!requested || !known.includes(requested)) {
        throw new UnknownRuntimeError(requested, healthyRuntimeIds);
      }
      // `known` is derived from listRuntimeIds() via detectRuntimes(), so
      // `requested` (checked to be in `known` above) is guaranteed to be a
      // valid RuntimeId — cast to satisfy the typed factory map.
      return getDriver(requested as Parameters<typeof getDriver>[0]);
    },
    capabilities: CAPABILITIES,
    agentCliPath,
    workingDirectoryBase: baseDir,
    hostname: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    daemonVersion: readDaemonVersion(),
    onAuthRejected: () => {
      log.error("machine key rejected by server — is it correct / has it expired?");
      releaseLock(pf);
      process.exit(1);
    },
  });

  log.info(`daemon up — proxy at ${daemon.proxyUrl}, dialing ${wsUrl}`);

  const readyTimer = setInterval(() => {
    if (daemon.isOpen()) {
      clearInterval(readyTimer);
      log.info("control plane OPEN");
    }
  }, 200);
  readyTimer.unref?.();

  const shutdown = async () => {
    log.info("shutting down…");
    clearInterval(readyTimer);
    releaseLock(pf);
    await daemon.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep the process alive.
  await new Promise(() => {});
}
