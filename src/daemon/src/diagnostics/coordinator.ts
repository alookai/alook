import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  createReadStream,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import type { DiagnosticCollectCommand, DiagnosticReportFailureCode } from "@alook/shared";
import type {
  DiagnosticBundleBuilder,
  DiagnosticCoordinatorResult,
  DiagnosticTransport,
} from "./types.js";

export const DIAGNOSTIC_COORDINATOR_CRASH_POINTS = [
  "collecting_temp_written",
  "collecting_temp_fsynced",
  "collecting_renamed",
  "collecting_dir_fsynced",
  "archive_temp_written",
  "archive_temp_fsynced",
  "archive_renamed",
  "archive_dir_fsynced",
  "ready_temp_written",
  "ready_temp_fsynced",
  "ready_renamed",
  "ready_dir_fsynced",
  "before_upload",
  "after_upload",
] as const;

export type DiagnosticCoordinatorCrashPoint = typeof DIAGNOSTIC_COORDINATOR_CRASH_POINTS[number];

interface CollectingSidecar {
  schemaVersion: 1;
  phase: "collecting";
  reportId: string;
  agentId: string;
  fromMs: number;
  deadlineAt: number;
}

interface ReadySidecar extends Omit<CollectingSidecar, "phase"> {
  phase: "ready";
  sizeBytes: number;
  sha256: string;
}

type Sidecar = CollectingSidecar | ReadySidecar;

interface FsOps {
  randomSuffix(): string;
  open(path: string, flags: "wx" | "r", mode?: number): number;
  write(fd: number, bytes: Uint8Array): void;
  fsync(fd: number): void;
  close(fd: number): void;
  rename(from: string, to: string): void;
  fsyncDirectory(path: string): void;
}

class CoordinatorError extends Error {
  constructor(readonly code: "coordinator_shutdown" | "local_artifact_invalid") { super(code); }
}

function defaultFsOps(): FsOps {
  return {
    randomSuffix: () => randomBytes(12).toString("hex"),
    open: (path, flags, mode) => openSync(path, flags, mode),
    write: (fd, bytes) => { writeSync(fd, bytes); },
    fsync: (fd) => { fsyncSync(fd); },
    close: (fd) => { closeSync(fd); },
    rename: (from, to) => { renameSync(from, to); },
    fsyncDirectory: (path) => {
      if (process.platform === "win32") return;
      const fd = openSync(path, "r");
      try { fsyncSync(fd); } finally { closeSync(fd); }
    },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function safeEpoch(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseSidecar(value: unknown): Sidecar | null {
  if (!isObject(value) || value.schemaVersion !== 1 || (value.phase !== "collecting" && value.phase !== "ready")) return null;
  const baseKeys = ["schemaVersion", "phase", "reportId", "agentId", "fromMs", "deadlineAt"];
  const keys = value.phase === "ready" ? [...baseKeys, "sizeBytes", "sha256"] : baseKeys;
  if (!exactKeys(value, keys)
    || typeof value.reportId !== "string" || !/^dbr_[A-Za-z0-9_-]+$/.test(value.reportId)
    || typeof value.agentId !== "string" || !/^[A-Za-z0-9_-]+$/.test(value.agentId)
    || !safeEpoch(value.fromMs) || !safeEpoch(value.deadlineAt)) return null;
  if (value.phase === "ready") {
    if (!safeEpoch(value.sizeBytes) || typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)) return null;
    return value as unknown as ReadySidecar;
  }
  return value as unknown as CollectingSidecar;
}

function sameCommand(sidecar: Sidecar, command: DiagnosticCollectCommand): boolean {
  return sidecar.reportId === command.reportId
    && sidecar.agentId === command.agentId
    && sidecar.fromMs === command.fromMs
    && sidecar.deadlineAt === command.deadlineAt;
}

function commandFrom(sidecar: Sidecar): DiagnosticCollectCommand {
  return { type: "diagnostics:collect", reportId: sidecar.reportId, agentId: sidecar.agentId, fromMs: sidecar.fromMs, deadlineAt: sidecar.deadlineAt };
}

export function createDiagnosticReportCoordinator(args: {
  machineDir: string;
  buildBundle: DiagnosticBundleBuilder;
  transport: DiagnosticTransport;
  now: () => number;
  sleep: (delayMs: number) => Promise<void>;
  scheduleRetry: (delayMs: number, task: () => Promise<void>) => () => void;
  retry: { maxAttemptsPerRound: number; baseDelayMs: number; maxDelayMs: number };
  checkpoint?: (point: DiagnosticCoordinatorCrashPoint) => void;
  fsOps?: FsOps;
  logger?: { warn(message: string, fields: Record<string, unknown>): void };
}): {
  collect(command: DiagnosticCollectCommand): Promise<DiagnosticCoordinatorResult>;
  recover(): Promise<void>;
  shutdown(): Promise<void>;
} {
  const fsOps = args.fsOps ?? defaultFsOps();
  const dir = join(args.machineDir, "diagnostics");
  let stopped = false;
  let active: { command: DiagnosticCollectCommand; promise: Promise<DiagnosticCoordinatorResult> } | null = null;
  const retryCancels = new Set<() => void>();

  const checkpoint = (point: DiagnosticCoordinatorCrashPoint): void => { args.checkpoint?.(point); };
  const archivePath = (reportId: string): string => join(dir, `report-${reportId}.ndjson.gz`);
  const sidecarPath = (reportId: string): string => join(dir, `report-${reportId}.json`);

  const ensureDir = (): void => {
    if (existsSync(dir)) {
      const stat = lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new CoordinatorError("local_artifact_invalid");
      if (process.platform !== "win32") chmodSync(dir, 0o700);
      return;
    }
    mkdirSync(dir, { mode: 0o700 });
  };

  const safeWarn = (reportId: string): void => {
    try { args.logger?.warn("diagnostic local artifact invalid", { reportId, code: "local_artifact_invalid" }); } catch { /* diagnostic logging is fail-safe */ }
  };

  const removeExact = (path: string): void => {
    try {
      const stat = lstatSync(path);
      if (stat.isFile() && !stat.isSymbolicLink()) unlinkSync(path);
    } catch { /* missing/unsafe artifacts are left untouched */ }
  };

  const cleanup = (reportId: string): void => {
    removeExact(archivePath(reportId));
    removeExact(sidecarPath(reportId));
  };

  const durableSidecar = (sidecar: Sidecar): void => {
    const destination = sidecarPath(sidecar.reportId);
    const bytes = Buffer.from(JSON.stringify(sidecar), "utf8");
    let temp = "";
    let fd: number | null = null;
    for (let attempt = 0; attempt < 32; attempt += 1) {
      temp = join(dir, `.${sidecar.reportId}.${sidecar.phase}.${fsOps.randomSuffix()}.tmp`);
      try {
        fd = fsOps.open(temp, "wx", 0o600);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    if (fd === null) throw new Error("unable to reserve diagnostic sidecar temp");
    try {
      fsOps.write(fd, bytes);
      checkpoint(sidecar.phase === "collecting" ? "collecting_temp_written" : "ready_temp_written");
      fsOps.fsync(fd);
      checkpoint(sidecar.phase === "collecting" ? "collecting_temp_fsynced" : "ready_temp_fsynced");
    } finally {
      fsOps.close(fd);
    }
    fsOps.rename(temp, destination);
    checkpoint(sidecar.phase === "collecting" ? "collecting_renamed" : "ready_renamed");
    fsOps.fsyncDirectory(dir);
    checkpoint(sidecar.phase === "collecting" ? "collecting_dir_fsynced" : "ready_dir_fsynced");
  };

  const committedArchive = (reportId: string): { sizeBytes: number; sha256: string } | null => {
    const path = archivePath(reportId);
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) return null;
      const bytes = readFileSync(path);
      return { sizeBytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
    } catch {
      return null;
    }
  };

  const scheduleTask = (delayMs: number, taskBody: () => Promise<void>): void => {
    let cancel = () => {};
    const task = async (): Promise<void> => {
      retryCancels.delete(cancel);
      if (stopped) return;
      await taskBody();
    };
    cancel = args.scheduleRetry(delayMs, task);
    retryCancels.add(cancel);
  };

  const retryFailure = async (
    reportId: string,
    failureCode: DiagnosticReportFailureCode,
    options: { cleanupArtifacts: boolean; deadlineAt?: number },
  ): Promise<DiagnosticCoordinatorResult> => {
    if (options.deadlineAt !== undefined && args.now() >= options.deadlineAt) {
      if (options.cleanupArtifacts) cleanup(reportId);
      return { status: "expired" };
    }
    for (let attempt = 0; attempt < args.retry.maxAttemptsPerRound; attempt += 1) {
      if (stopped) throw new CoordinatorError("coordinator_shutdown");
      const result = await args.transport.fail(reportId, failureCode);
      if (result.kind === "terminal") {
        if (options.cleanupArtifacts) cleanup(reportId);
        return { status: "failed", failureCode };
      }
      if (attempt + 1 < args.retry.maxAttemptsPerRound) {
        await args.sleep(Math.min(args.retry.maxDelayMs, args.retry.baseDelayMs * 2 ** attempt));
      }
    }
    const delay = Math.min(args.retry.maxDelayMs, args.retry.baseDelayMs * 2 ** Math.max(0, args.retry.maxAttemptsPerRound - 1));
    scheduleTask(delay, async () => { await retryFailure(reportId, failureCode, options); });
    return { status: "pending" };
  };

  const invalid = async (reportId: string, deadlineAt?: number): Promise<DiagnosticCoordinatorResult> => {
    safeWarn(reportId);
    return retryFailure(reportId, "local_artifact_invalid", { cleanupArtifacts: true, deadlineAt });
  };

  const uploadReady = async (sidecar: ReadySidecar): Promise<DiagnosticCoordinatorResult> => {
    if (stopped) throw new CoordinatorError("coordinator_shutdown");
    if (args.now() >= sidecar.deadlineAt) {
      cleanup(sidecar.reportId);
      return { status: "expired" };
    }
    const actual = committedArchive(sidecar.reportId);
    if (!actual || actual.sizeBytes !== sidecar.sizeBytes || actual.sha256 !== sidecar.sha256) {
      return invalid(sidecar.reportId, sidecar.deadlineAt);
    }
    for (let attempt = 0; attempt < args.retry.maxAttemptsPerRound; attempt += 1) {
      if (stopped) throw new CoordinatorError("coordinator_shutdown");
      checkpoint("before_upload");
      const result = await args.transport.upload(
        { reportId: sidecar.reportId, sizeBytes: sidecar.sizeBytes, sha256: sidecar.sha256 },
        createReadStream(archivePath(sidecar.reportId)),
      );
      checkpoint("after_upload");
      if (result.kind === "terminal") {
        cleanup(sidecar.reportId);
        return { status: result.status };
      }
      if (attempt + 1 < args.retry.maxAttemptsPerRound) {
        const delay = Math.min(args.retry.maxDelayMs, args.retry.baseDelayMs * 2 ** attempt);
        await args.sleep(delay);
      }
    }
    const delay = Math.min(args.retry.maxDelayMs, args.retry.baseDelayMs * 2 ** Math.max(0, args.retry.maxAttemptsPerRound - 1));
    scheduleTask(delay, async () => { await uploadReady(sidecar); });
    return { status: "pending" };
  };

  const promoteArchive = (collecting: CollectingSidecar): ReadySidecar | null => {
    const actual = committedArchive(collecting.reportId);
    if (!actual) return null;
    const ready: ReadySidecar = { ...collecting, phase: "ready", ...actual };
    durableSidecar(ready);
    return ready;
  };

  const buildAndCommit = async (command: DiagnosticCollectCommand, collecting: CollectingSidecar): Promise<ReadySidecar> => {
    const temp = join(dir, `.${command.reportId}.archive.${fsOps.randomSuffix()}.tmp`);
    const artifact = await args.buildBundle({ command, outputPath: temp });
    checkpoint("archive_temp_written");
    const fd = fsOps.open(artifact.path, "r");
    try { fsOps.fsync(fd); checkpoint("archive_temp_fsynced"); } finally { fsOps.close(fd); }
    fsOps.rename(artifact.path, archivePath(command.reportId));
    if (process.platform !== "win32") chmodSync(archivePath(command.reportId), 0o600);
    checkpoint("archive_renamed");
    fsOps.fsyncDirectory(dir);
    checkpoint("archive_dir_fsynced");
    const actual = committedArchive(command.reportId);
    if (!actual || actual.sizeBytes !== artifact.sizeBytes || actual.sha256 !== artifact.sha256) throw new CoordinatorError("local_artifact_invalid");
    const ready: ReadySidecar = { ...collecting, phase: "ready", ...actual };
    durableSidecar(ready);
    return ready;
  };

  const processNew = async (command: DiagnosticCollectCommand): Promise<DiagnosticCoordinatorResult> => {
    ensureDir();
    const collecting: CollectingSidecar = {
      schemaVersion: 1,
      phase: "collecting",
      reportId: command.reportId,
      agentId: command.agentId,
      fromMs: command.fromMs,
      deadlineAt: command.deadlineAt,
    };
    durableSidecar(collecting);
    const ready = await buildAndCommit(command, collecting);
    return uploadReady(ready);
  };

  const readSidecar = (reportId: string): Sidecar | null => {
    const path = sidecarPath(reportId);
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) return null;
      return parseSidecar(JSON.parse(readFileSync(path, "utf8")));
    } catch {
      return null;
    }
  };

  const resume = async (sidecar: Sidecar): Promise<DiagnosticCoordinatorResult> => {
    if (args.now() >= sidecar.deadlineAt) { cleanup(sidecar.reportId); return { status: "expired" }; }
    if (sidecar.phase === "ready") return uploadReady(sidecar);
    const promoted = promoteArchive(sidecar);
    if (promoted) return uploadReady(promoted);
    const ready = await buildAndCommit(commandFrom(sidecar), sidecar);
    return uploadReady(ready);
  };

  const collect = async (command: DiagnosticCollectCommand): Promise<DiagnosticCoordinatorResult> => {
    if (stopped) throw new CoordinatorError("coordinator_shutdown");
    if (active) {
      if (active.command.reportId === command.reportId) {
        return sameCommand({ schemaVersion: 1, phase: "collecting", ...active.command }, command)
          ? active.promise
          : { status: "failed", failureCode: "local_artifact_invalid" };
      }
      return retryFailure(command.reportId, "collector_busy", { cleanupArtifacts: false, deadlineAt: command.deadlineAt });
    }
    ensureDir();
    let task: Promise<DiagnosticCoordinatorResult>;
    const persistedPath = sidecarPath(command.reportId);
    if (existsSync(persistedPath) || existsSync(archivePath(command.reportId))) {
      const persisted = readSidecar(command.reportId);
      task = !persisted || !sameCommand(persisted, command) ? invalid(command.reportId, persisted?.deadlineAt) : resume(persisted);
    } else {
      task = processNew(command);
    }
    active = { command, promise: task };
    try { return await task; } finally { if (active?.promise === task) active = null; }
  };

  const recover = async (): Promise<void> => {
    if (stopped) throw new CoordinatorError("coordinator_shutdown");
    ensureDir();
    const names = readdirSync(dir);
    const ids = new Set<string>();
    for (const name of names) {
      const match = /^report-(dbr_[A-Za-z0-9_-]+)(?:\.json|\.ndjson\.gz)$/.exec(name);
      if (match?.[1]) ids.add(match[1]);
    }
    for (const reportId of ids) {
      if (stopped) throw new CoordinatorError("coordinator_shutdown");
      const hasSidecar = existsSync(sidecarPath(reportId));
      const hasArchive = existsSync(archivePath(reportId));
      if (!hasSidecar) { if (hasArchive) await invalid(reportId); continue; }
      const sidecar = readSidecar(reportId);
      if (!sidecar || sidecar.reportId !== reportId) { await invalid(reportId, sidecar?.deadlineAt); continue; }
      await resume(sidecar);
    }
  };

  const shutdown = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    for (const cancel of retryCancels) { try { cancel(); } catch { /* best effort */ } }
    retryCancels.clear();
  };

  return { collect, recover, shutdown };
}
