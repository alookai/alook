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
import { homedir } from "os";
import { WebSocket } from "ws";
import { createDaemon } from "../daemon/createDaemon";
import { ClaudeDriver } from "../drivers/claude";
import { createLogger } from "../logger";

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

export async function daemonStart(opts: DaemonStartOpts): Promise<void> {
  const serverUrl = opts.serverUrl || process.env.ALOOK_SERVER_URL;
  const wsUrl = opts.wsUrl || process.env.ALOOK_SERVER_WS_URL;

  if (!serverUrl) {
    log.error("server URL required — pass --server-url or set ALOOK_SERVER_URL");
    process.exit(2);
  }
  if (!wsUrl) {
    log.error("WebSocket URL required — pass --ws-url or set ALOOK_SERVER_WS_URL");
    process.exit(2);
  }

  const baseDir = opts.baseDir || process.env.ALOOK_DATA_DIR || DEFAULT_BASE_DIR;
  const pf = acquireLock(baseDir, opts.machineKey);

  const agentCliPath = process.argv[1];
  const driver = new ClaudeDriver();

  const daemon = await createDaemon({
    machineKey: opts.machineKey,
    serverUrl,
    serverWsUrl: wsUrl,
    webSocketFactory: (url, headers) => new WebSocket(url, { headers }),
    runtimes: ["claude"],
    driverFor: () => driver,
    capabilities: CAPABILITIES,
    agentCliPath,
    workingDirectoryBase: baseDir,
  });

  log.info(`daemon up — proxy at ${daemon.proxyUrl}, dialing ${wsUrl}`);

  const readyTimer = setInterval(() => {
    if (daemon.isOpen()) {
      clearInterval(readyTimer);
      log.info("control plane OPEN — routing to real Claude agents");
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
