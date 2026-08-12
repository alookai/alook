import * as fs from "node:fs";
import * as path from "node:path";
import { WebSocket } from "ws";
import { createDaemon } from "../daemon/createDaemon.js";
import { getDriver, listRuntimeIds } from "../drivers/index.js";
import type { RuntimeInfo } from "../discovery.js";
import { createLogger, type Logger } from "../logger.js";
import { UnknownRuntimeError } from "../manager/agentRouter.js";
import { scrubRuntimeErrorDiagnosticText } from "../runtime/errorDiagnostics.js";
import { createRotatingFileSink, type RotatingFileSink } from "../util/rotatingFileSink.js";

const CAPABILITIES = ["send", "read", "mentions", "tasks", "reactions", "server", "channels", "knowledge", "attach", "friend"];
export const DAEMON_LOG_MAX_BYTES = 8 * 1024 * 1024;
const DAEMON_ERROR_MESSAGE_MAX_CHARS = 512;

export interface PreparedDaemon {
  machineId: string;
  machineKey: string;
  serverUrl: string;
  wsUrl: string;
  baseDir: string;
  daemonDir: string;
  statusFilePath: string;
  agentCliPath: string | undefined;
  runtimeReport: RuntimeInfo[];
  healthyRuntimeIds: string[];
  hostname: string;
  platform: string;
  arch: string;
  osRelease: string;
  daemonVersion: string;
  ownerToken: string;
  startedAt: string;
}

export interface DaemonReadyReceipt {
  pid: number;
  machineId: string;
  logPath: string;
  startedAt: string;
}

export interface RunPreparedDaemonOptions {
  foreground: boolean;
  onReady?: (receipt: DaemonReadyReceipt) => void;
  releaseOwnership: () => void;
}

export function logDaemonStartup(log: Logger, prepared: PreparedDaemon): void {
  log.info("daemon startup", {
    machineId: prepared.machineId,
    version: prepared.daemonVersion,
    healthyRuntimeIds: prepared.runtimeReport
      .filter((runtime) => runtime.status === "healthy")
      .map((runtime) => runtime.id),
    unhealthyRuntimeIds: prepared.runtimeReport
      .filter((runtime) => runtime.status !== "healthy")
      .map((runtime) => runtime.id),
  });
}

function protocolOf(value: string): string {
  try {
    return new URL(value).protocol.replace(/:$/, "");
  } catch {
    return "unknown";
  }
}

export function logDaemonUp(log: Logger, proxyUrl: string, controlUrl: string): void {
  log.info("daemon up", {
    proxyProtocol: protocolOf(proxyUrl),
    controlProtocol: protocolOf(controlUrl),
  });
}

function safeDaemonError(error: unknown): { errorClass: string; error: string } {
  const errorClass = error instanceof Error ? error.name : typeof error;
  const raw = error instanceof Error ? error.message : String(error);
  const scrubbed = scrubRuntimeErrorDiagnosticText(raw)
    .replace(/\b(?:cmk|cmt)_[A-Za-z0-9_-]+\b/g, "[redacted-token]")
    .slice(0, DAEMON_ERROR_MESSAGE_MAX_CHARS);
  return { errorClass, error: scrubbed };
}

export function createDaemonProcessLogger(
  daemonDir: string,
  foreground: boolean,
): { logger: Logger; logPath: string; sink: RotatingFileSink } {
  fs.mkdirSync(daemonDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(daemonDir, 0o700);
  const logPath = path.join(daemonDir, "daemon.log");
  let warnedOversize = false;
  const sink: RotatingFileSink = createRotatingFileSink(logPath, DAEMON_LOG_MAX_BYTES, {
    mode: 0o600,
    hardMaxBytes: true,
    onError: ({ operation }) => {
      if ((operation !== "oversize" && operation !== "oversize_generation") || warnedOversize) return;
      warnedOversize = true;
      sink.write(JSON.stringify({
        time: new Date().toISOString(),
        header: "@alook/daemon",
        level: "warn",
        message: operation === "oversize"
          ? "daemon log record dropped: oversize"
          : "oversize daemon log generation removed",
        fields: {},
      }));
    },
  });
  if (!sink.secure()) throw new Error("failed to secure daemon log generations");
  const quiet = () => {};
  const logger = createLogger({
    header: "@alook/daemon",
    out: foreground ? (line) => process.stdout.write(line + "\n") : quiet,
    err: foreground ? (line) => process.stderr.write(line + "\n") : quiet,
    record: (record) => sink.write(JSON.stringify(record)),
  });
  return { logger, logPath, sink };
}

export async function runPreparedDaemon(
  prepared: PreparedDaemon,
  opts: RunPreparedDaemonOptions,
): Promise<never> {
  let processLogger: ReturnType<typeof createDaemonProcessLogger>;
  try {
    processLogger = createDaemonProcessLogger(prepared.daemonDir, opts.foreground);
  } catch (error) {
    opts.releaseOwnership();
    throw error;
  }
  const { logger: log, logPath } = processLogger;
  let shuttingDown = false;
  let daemon: Awaited<ReturnType<typeof createDaemon>> | null = null;
  const keepAlive = setInterval(() => {}, 24 * 60 * 60 * 1000);

  const testShutdownDelay = async (): Promise<void> => {
    if (process.env.NODE_ENV !== "test") return;
    const delayMs = Number(process.env.ALOOK_DAEMON_TEST_SHUTDOWN_DELAY_MS);
    if (!Number.isFinite(delayMs) || delayMs <= 0) return;
    const marker = process.env.ALOOK_DAEMON_TEST_SHUTDOWN_MARKER;
    if (marker) fs.writeFileSync(marker, String(process.pid), { mode: 0o600 });
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  };

  const stopDaemon = async (): Promise<void> => {
    if (process.env.NODE_ENV === "test" && process.env.ALOOK_DAEMON_TEST_STOP_REJECT === "1") {
      throw new Error("test teardown failed cmk_B0_FATAL_SECRET");
    }
    await daemon?.stop();
  };

  const shutdown = async (exitCode: number): Promise<never> => {
    if (shuttingDown) return await new Promise<never>(() => {});
    shuttingDown = true;
    clearInterval(keepAlive);
    log.info("shutting down…");
    try {
      await testShutdownDelay();
      await stopDaemon();
    } catch (error) {
      log.error("daemon teardown failed", safeDaemonError(error));
    } finally {
      try {
        opts.releaseOwnership();
      } catch (error) {
        log.error("daemon ownership release failed", safeDaemonError(error));
      } finally {
        process.exit(exitCode);
      }
    }
  };

  process.once("uncaughtException", (error) => {
    log.error("uncaught exception", safeDaemonError(error));
    void shutdown(1);
  });
  process.once("unhandledRejection", (reason) => {
    log.error("unhandled rejection", safeDaemonError(reason));
    void shutdown(1);
  });
  process.once("SIGINT", () => { void shutdown(0); });
  process.once("SIGTERM", () => { void shutdown(0); });

  try {
    logDaemonStartup(log, prepared);
    daemon = await createDaemon({
      machineKey: prepared.machineKey,
      serverUrl: prepared.serverUrl,
      serverWsUrl: prepared.wsUrl,
      webSocketFactory: (url, headers) => new WebSocket(url, { headers }),
      runtimeReport: prepared.runtimeReport,
      driverFor: (_agentId, runtimeConfig) => {
        const requested = runtimeConfig?.runtime;
        const known: string[] = listRuntimeIds();
        if (!requested || !known.includes(requested)) {
          throw new UnknownRuntimeError(requested, prepared.healthyRuntimeIds);
        }
        return getDriver(requested as Parameters<typeof getDriver>[0]);
      },
      capabilities: CAPABILITIES,
      agentCliPath: prepared.agentCliPath,
      workingDirectoryBase: prepared.baseDir,
      fsmTraceDir: prepared.daemonDir,
      statusFilePath: prepared.statusFilePath,
      hostname: prepared.hostname,
      platform: prepared.platform,
      arch: prepared.arch,
      osRelease: prepared.osRelease,
      daemonVersion: prepared.daemonVersion,
      logger: log,
      onAuthRejected: () => {
        log.error("machine key rejected by server — is it correct / has it expired?");
        void shutdown(1);
      },
    });
  } catch (error) {
    clearInterval(keepAlive);
    log.error("daemon runner initialization failed", safeDaemonError(error));
    opts.releaseOwnership();
    throw error;
  }

  logDaemonUp(log, daemon.proxyUrl, prepared.wsUrl);
  daemon.onOpen(() => log.info("control plane OPEN"));
  opts.onReady?.({
    pid: process.pid,
    machineId: prepared.machineId,
    logPath,
    startedAt: prepared.startedAt,
  });
  if (process.env.NODE_ENV === "test" && process.env.ALOOK_DAEMON_TEST_FATAL_AFTER_READY === "1") {
    setTimeout(() => {
      void Promise.reject(new Error("test fatal cmk_B0_FATAL_SECRET"));
    }, 250);
  }
  return await new Promise<never>(() => {});
}
