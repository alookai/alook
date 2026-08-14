import * as fs from "node:fs";
import * as path from "node:path";
import { WebSocket } from "ws";
import type { DiagnosticCollectCommand, DiagnosticReportFailureCode } from "@alook/shared";
import { createDaemon } from "../daemon/createDaemon.js";
import {
  buildDiagnosticBundle,
  createDiagnosticHttpTransport,
  createDiagnosticReportCoordinator,
  mergeChronologicalSnapshotRows,
  projectDaemonLogRow,
  projectFsmTraceRow,
  projectStatusRow,
  readPinnedJsonFile,
  readSnapshotJsonLines,
  type DiagnosticEventRow,
  type SnapshotReadResult,
} from "../diagnostics/index.js";
import { getDriver, listRuntimeIds } from "../drivers/index.js";
import type { RuntimeInfo } from "../discovery.js";
import { createLogger, type Logger } from "../logger.js";
import { UnknownRuntimeError } from "../manager/agentRouter.js";
import { scrubRuntimeErrorDiagnosticText } from "../runtime/errorDiagnostics.js";
import { createRotatingFileSink, type RotatingFileSink } from "../util/rotatingFileSink.js";
import { createDaemonSelfUpdateHandler } from "./daemonUpdate.js";

const CAPABILITIES = ["send", "read", "mentions", "tasks", "reactions", "server", "channels", "knowledge", "attach", "friend", "profile"];
export const DAEMON_LOG_MAX_BYTES = 8 * 1024 * 1024;
const DAEMON_ERROR_MESSAGE_MAX_CHARS = 512;
const DIAGNOSTIC_MAX_LINE_BYTES = 128 * 1024;
const DIAGNOSTIC_MAX_STATUS_BYTES = 1024 * 1024;

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

function diagnosticTimestamp(source: "daemon_log" | "fsm_trace", value: Record<string, unknown>): number | null {
  if (source === "fsm_trace") {
    return typeof value.nowMs === "number" && Number.isSafeInteger(value.nowMs) ? value.nowMs : null;
  }
  if (typeof value.time !== "string") return null;
  const parsed = Date.parse(value.time);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

async function diagnosticRows(args: {
  source: Pick<RotatingFileSink, "openSnapshot"> | null;
  sourceName: "daemon_log" | "fsm_trace";
  fromMs: number;
}): Promise<SnapshotReadResult> {
  if (!args.source) return { rows: [], warnings: ["source_unavailable"], droppedRows: 0 };
  return readSnapshotJsonLines({
    source: args.source,
    sourceName: args.sourceName,
    fromMs: args.fromMs,
    maxLineBytes: DIAGNOSTIC_MAX_LINE_BYTES,
    timestampOf: (value) => diagnosticTimestamp(args.sourceName, value),
  });
}

async function buildRunnerDiagnosticBundle(args: {
  command: DiagnosticCollectCommand;
  outputPath: string;
  machineId: string;
  daemonLogSource: Pick<RotatingFileSink, "openSnapshot">;
  fsmTraceSource: Pick<RotatingFileSink, "openSnapshot"> | null;
  statusFilePath: string | undefined;
  now: () => number;
}) {
  const [daemon, fsm, statusRead] = await Promise.all([
    diagnosticRows({ source: args.daemonLogSource, sourceName: "daemon_log", fromMs: args.command.fromMs }),
    diagnosticRows({ source: args.fsmTraceSource, sourceName: "fsm_trace", fromMs: args.command.fromMs }),
    args.statusFilePath
      ? readPinnedJsonFile({ path: args.statusFilePath, maxBytes: DIAGNOSTIC_MAX_STATUS_BYTES })
      : Promise.resolve({ value: null, warnings: ["source_unavailable"] as const }),
  ]);
  const warnings: string[] = [...daemon.warnings, ...fsm.warnings, ...statusRead.warnings];
  if (daemon.warnings.includes("source_unavailable")) warnings.push("daemon_log_missing");
  if (fsm.warnings.includes("source_unavailable")) warnings.push("fsm_trace_missing");
  const status = projectStatusRow(statusRead.value, args.command.agentId);
  if (!status) warnings.push("status_missing");

  const droppedRows = {
    daemon_log: daemon.droppedRows,
    fsm: fsm.droppedRows,
    status: statusRead.value !== null && !status ? 1 : 0,
  };
  const events: DiagnosticEventRow[] = [];
  for (const row of mergeChronologicalSnapshotRows([daemon.rows, fsm.rows])) {
    const projected = row.source === "daemon_log"
      ? projectDaemonLogRow(row.value, args.command.agentId)
      : projectFsmTraceRow(row.value, args.command.agentId);
    if (!projected || (projected.recordType !== "daemon_log" && projected.recordType !== "fsm")) {
      droppedRows[row.source === "daemon_log" ? "daemon_log" : "fsm"] += 1;
      continue;
    }
    events.push({
      ...projected,
      recordType: projected.recordType,
      timeMs: row.timeMs,
    });
  }

  return buildDiagnosticBundle({
    outputPath: args.outputPath,
    header: {
      recordType: "bundle_header",
      schemaVersion: 1,
      reportId: args.command.reportId,
      agentId: args.command.agentId,
      machineId: args.machineId,
      capturedAt: args.now(),
      fromMs: args.command.fromMs,
      deadlineAt: args.command.deadlineAt,
    },
    status,
    events,
    sourceWarnings: warnings,
    sourceDroppedRows: droppedRows,
  });
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
  const { logger: log, logPath, sink: daemonLogSource } = processLogger;
  let shuttingDown = false;
  let daemon: Awaited<ReturnType<typeof createDaemon>> | null = null;
  const diagnosticLifecycle: {
    coordinator: ReturnType<typeof createDiagnosticReportCoordinator> | null;
  } = { coordinator: null };
  const diagnosticTransport = createDiagnosticHttpTransport({
    serverUrl: prepared.serverUrl,
    machineKey: prepared.machineKey,
  });
  const keepAlive = setInterval(() => {}, 24 * 60 * 60 * 1000);

  const reportDiagnosticFailure = async (failure: {
    reportId: string;
    failureCode: DiagnosticReportFailureCode;
  }): Promise<void> => {
    await diagnosticTransport.fail(failure.reportId, failure.failureCode);
  };

  const handleDiagnosticCommand = async (command: DiagnosticCollectCommand): Promise<void> => {
    try {
      if (!diagnosticLifecycle.coordinator) {
        await reportDiagnosticFailure({
          reportId: command.reportId,
          failureCode: "diagnostics_unavailable",
        });
        return;
      }
      await diagnosticLifecycle.coordinator.collect(command);
    } catch (error) {
      const failureCode: DiagnosticReportFailureCode =
        error !== null
          && typeof error === "object"
          && "code" in error
          && error.code === "bundle_too_large"
          ? "bundle_too_large"
          : "collection_failed";
      await reportDiagnosticFailure({ reportId: command.reportId, failureCode });
    }
  };

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
    try {
      await diagnosticLifecycle.coordinator?.shutdown();
    } finally {
      await daemon?.stop();
    }
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
    const handleSelfUpdate = createDaemonSelfUpdateHandler({
      machineId: prepared.machineId,
      baseDir: prepared.baseDir,
      pid: process.pid,
      startedAt: prepared.startedAt,
      ownerToken: prepared.ownerToken,
    }, { logger: log });
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
      handleSelfUpdate,
      handleDiagnosticCommand,
      reportDiagnosticFailure,
      onDiagnosticSources: ({ fsmTraceSource, statusFilePath }) => {
        if (diagnosticLifecycle.coordinator) return;
        diagnosticLifecycle.coordinator = createDiagnosticReportCoordinator({
          machineDir: prepared.daemonDir,
          buildBundle: ({ command, outputPath }) => buildRunnerDiagnosticBundle({
            command,
            outputPath,
            machineId: prepared.machineId,
            daemonLogSource,
            fsmTraceSource,
            statusFilePath,
            now: Date.now,
          }),
          transport: diagnosticTransport,
          now: Date.now,
          sleep: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
          scheduleRetry: (delayMs, task) => {
            const timer = setTimeout(() => {
              void task().catch((error) => {
                log.warn("diagnostic retry failed", safeDaemonError(error));
              });
            }, delayMs);
            timer.unref?.();
            return () => clearTimeout(timer);
          },
          retry: { maxAttemptsPerRound: 3, baseDelayMs: 250, maxDelayMs: 30_000 },
          logger: {
            warn: (message, fields) => log.warn(message, fields),
          },
        });
      },
      onAuthRejected: () => {
        log.error("machine key rejected by server — is it correct / has it expired?");
        void shutdown(1);
      },
    });
  } catch (error) {
    clearInterval(keepAlive);
    await diagnosticLifecycle.coordinator?.shutdown().catch(() => {});
    log.error("daemon runner initialization failed", safeDaemonError(error));
    opts.releaseOwnership();
    throw error;
  }

  if (diagnosticLifecycle.coordinator) {
    void diagnosticLifecycle.coordinator.recover().catch((error: unknown) => {
      log.warn("diagnostic recovery failed", safeDaemonError(error));
    });
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
