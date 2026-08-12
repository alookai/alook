import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiagnosticCollectCommand, DiagnosticReportFailureCode } from "@alook/shared";

type TransportResult =
  | { kind: "terminal"; status: "uploaded" | "failed" }
  | { kind: "retryable" };

interface DiagnosticTransport {
  upload(
    meta: { reportId: string; sizeBytes: number; sha256: string },
    body: Readable,
  ): Promise<TransportResult>;
  fail(reportId: string, failureCode: DiagnosticReportFailureCode): Promise<TransportResult>;
}

type CrashPoint =
  | "collecting_temp_written"
  | "collecting_temp_fsynced"
  | "collecting_renamed"
  | "collecting_dir_fsynced"
  | "archive_temp_written"
  | "archive_temp_fsynced"
  | "archive_renamed"
  | "archive_dir_fsynced"
  | "ready_temp_written"
  | "ready_temp_fsynced"
  | "ready_renamed"
  | "ready_dir_fsynced"
  | "before_upload"
  | "after_upload";

interface CoordinatorResult {
  status: "uploaded" | "failed" | "pending" | "expired";
  failureCode?: DiagnosticReportFailureCode;
}

interface CoordinatorModule {
  DIAGNOSTIC_COORDINATOR_CRASH_POINTS: readonly CrashPoint[];
  createDiagnosticReportCoordinator(args: {
    machineDir: string;
    buildBundle: (args: { command: DiagnosticCollectCommand; outputPath: string }) => Promise<{
      path: string;
      sizeBytes: number;
      sha256: string;
    }>;
    transport: DiagnosticTransport;
    now: () => number;
    sleep: (delayMs: number) => Promise<void>;
    scheduleRetry: (delayMs: number, task: () => Promise<void>) => () => void;
    retry: { maxAttemptsPerRound: number; baseDelayMs: number; maxDelayMs: number };
    checkpoint?: (point: CrashPoint) => void;
    fsOps?: {
      randomSuffix(): string;
      open(path: string, flags: "wx" | "r" | "r+", mode?: number): number;
      write(fd: number, bytes: Uint8Array): void;
      fsync(fd: number): void;
      close(fd: number): void;
      rename(from: string, to: string): void;
      fsyncDirectory(path: string): void;
    };
    logger?: { warn(message: string, fields: Record<string, unknown>): void };
  }): {
    collect(command: DiagnosticCollectCommand): Promise<CoordinatorResult>;
    recover(): Promise<void>;
    shutdown(): Promise<void>;
  };
}

async function loadSubject(): Promise<CoordinatorModule> {
  return vi.importActual<CoordinatorModule>("./coordinator.js");
}

const dirs = new Set<string>();

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "diagnostics-coordinator-"));
  dirs.add(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.clear();
});

function command(overrides: Partial<DiagnosticCollectCommand> = {}): DiagnosticCollectCommand {
  return {
    type: "diagnostics:collect",
    reportId: "dbr_report_1",
    agentId: "agent-1",
    fromMs: 1_000,
    deadlineAt: 86_401_000,
    ...overrides,
  };
}

async function streamBytes(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function coordinatorHarness(
  api: CoordinatorModule,
  overrides: Partial<Parameters<CoordinatorModule["createDiagnosticReportCoordinator"]>[0]> & { archiveBytes?: Buffer } = {},
) {
  const machineDir = overrides.machineDir ?? tempDir();
  const archiveBytes = overrides.archiveBytes ?? Buffer.from("fixed-gzip-archive-bytes");
  const buildBundle = overrides.buildBundle ?? vi.fn(async ({ outputPath }: { command: DiagnosticCollectCommand; outputPath: string }) => {
    writeFileSync(outputPath, archiveBytes, { flag: "wx", mode: 0o600 });
    return {
      path: outputPath,
      sizeBytes: archiveBytes.byteLength,
      sha256: createHash("sha256").update(archiveBytes).digest("hex"),
    };
  });
  const uploaded: Array<{ meta: { reportId: string; sizeBytes: number; sha256: string }; bytes: Buffer }> = [];
  const transport: DiagnosticTransport = overrides.transport ?? {
    upload: vi.fn(async (meta, body) => {
      uploaded.push({ meta, bytes: await streamBytes(body) });
      return { kind: "terminal", status: "uploaded" } as const;
    }),
    fail: vi.fn(async () => ({ kind: "terminal", status: "failed" }) as const),
  };
  const scheduled: Array<{ delayMs: number; task: () => Promise<void>; cancelled: boolean }> = [];
  const instance = api.createDiagnosticReportCoordinator({
    machineDir,
    buildBundle,
    transport,
    now: overrides.now ?? (() => 2_000),
    sleep: overrides.sleep ?? (async () => {}),
    scheduleRetry: overrides.scheduleRetry ?? ((delayMs, task) => {
      const entry = { delayMs, task, cancelled: false };
      scheduled.push(entry);
      return () => { entry.cancelled = true; };
    }),
    retry: overrides.retry ?? { maxAttemptsPerRound: 3, baseDelayMs: 10, maxDelayMs: 40 },
    checkpoint: overrides.checkpoint,
    fsOps: overrides.fsOps,
    logger: overrides.logger,
  });
  return { instance, machineDir, archiveBytes, buildBundle, transport, uploaded, scheduled };
}

function diagnosticsDir(machineDir: string): string {
  return join(machineDir, "diagnostics");
}

function archivePath(machineDir: string, reportId = "dbr_report_1"): string {
  return join(diagnosticsDir(machineDir), `report-${reportId}.ndjson.gz`);
}

function sidecarPath(machineDir: string, reportId = "dbr_report_1"): string {
  return join(diagnosticsDir(machineDir), `report-${reportId}.json`);
}

describe("B2c durable diagnostic coordinator", () => {
  it("commits an exact collecting sidecar before bundle creation and a ready sidecar before first upload", async () => {
    const api = await loadSubject();
    let harness!: ReturnType<typeof coordinatorHarness>;
    const archiveBytes = Buffer.from("fixed-gzip-archive-bytes");
    const sha256 = createHash("sha256").update(archiveBytes).digest("hex");
    const buildBundle = vi.fn(async ({ command: request, outputPath }: { command: DiagnosticCollectCommand; outputPath: string }) => {
      const collecting = JSON.parse(readFileSync(sidecarPath(harness.machineDir), "utf8")) as Record<string, unknown>;
      expect(collecting).toEqual({
        schemaVersion: 1,
        phase: "collecting",
        reportId: request.reportId,
        agentId: request.agentId,
        fromMs: request.fromMs,
        deadlineAt: request.deadlineAt,
      });
      expect(JSON.stringify(collecting)).not.toMatch(/archiveBasename|absolute|path|cmk_|credential/);
      writeFileSync(outputPath, archiveBytes, { flag: "wx", mode: 0o600 });
      return { path: outputPath, sizeBytes: archiveBytes.length, sha256 };
    });
    let inspectedBeforeFirstByte = false;
    const transport: DiagnosticTransport = {
      upload: vi.fn(async (meta, body) => {
        const ready = JSON.parse(readFileSync(sidecarPath(harness.machineDir), "utf8")) as Record<string, unknown>;
        expect(ready).toEqual({
          schemaVersion: 1,
          phase: "ready",
          reportId: "dbr_report_1",
          agentId: "agent-1",
          fromMs: 1_000,
          deadlineAt: 86_401_000,
          sizeBytes: archiveBytes.length,
          sha256,
        });
        const archiveStat = lstatSync(archivePath(harness.machineDir));
        expect(archiveStat.isFile()).toBe(true);
        expect(archiveStat.isSymbolicLink()).toBe(false);
        if (process.platform !== "win32") expect(archiveStat.mode & 0o777).toBe(0o600);
        expect(readFileSync(archivePath(harness.machineDir))).toEqual(archiveBytes);
        expect(meta).toEqual({ reportId: "dbr_report_1", sizeBytes: archiveBytes.length, sha256 });
        inspectedBeforeFirstByte = true;

        const uploadedBytes = await streamBytes(body);
        expect(uploadedBytes).toEqual(archiveBytes);
        expect(uploadedBytes.byteLength).toBe(ready.sizeBytes);
        expect(createHash("sha256").update(uploadedBytes).digest("hex")).toBe(ready.sha256);
        return { kind: "terminal", status: "uploaded" } as const;
      }),
      fail: vi.fn(async () => ({ kind: "terminal", status: "failed" }) as const),
    };
    harness = coordinatorHarness(api, { archiveBytes, buildBundle, transport });

    await expect(harness.instance.collect(command())).resolves.toEqual({ status: "uploaded" });
    expect(buildBundle).toHaveBeenCalledTimes(1);
    expect(inspectedBeforeFirstByte).toBe(true);
    expect(transport.upload).toHaveBeenCalledTimes(1);
    expect(transport.fail).not.toHaveBeenCalled();
    expect(existsSync(archivePath(harness.machineDir))).toBe(false);
    expect(existsSync(sidecarPath(harness.machineDir))).toBe(false);
  });

  it("singleflights identical duplicates and rejects metadata conflicts without recollecting", async () => {
    const api = await loadSubject();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const base = coordinatorHarness(api);
    const buildBundle = vi.fn(async ({ outputPath }: { command: DiagnosticCollectCommand; outputPath: string }) => {
      await gate;
      writeFileSync(outputPath, base.archiveBytes, { flag: "wx", mode: 0o600 });
      return { path: outputPath, sizeBytes: base.archiveBytes.length, sha256: createHash("sha256").update(base.archiveBytes).digest("hex") };
    });
    const harness = coordinatorHarness(api, { machineDir: base.machineDir, buildBundle, transport: base.transport });

    const first = harness.instance.collect(command());
    const duplicate = harness.instance.collect(command());
    const conflict = harness.instance.collect(command({ agentId: "agent-2" }));
    release();

    await expect(first).resolves.toEqual({ status: "uploaded" });
    await expect(duplicate).resolves.toEqual({ status: "uploaded" });
    await expect(conflict).resolves.toEqual({ status: "failed", failureCode: "local_artifact_invalid" });
    expect(buildBundle).toHaveBeenCalledTimes(1);
    expect(base.transport.upload).toHaveBeenCalledTimes(1);
    expect(base.transport.fail).not.toHaveBeenCalled();
  });

  it("fails a different concurrent report as collector_busy without disturbing the active report", async () => {
    const api = await loadSubject();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const base = coordinatorHarness(api);
    const buildBundle = vi.fn(async ({ outputPath }: { command: DiagnosticCollectCommand; outputPath: string }) => {
      await gate;
      writeFileSync(outputPath, base.archiveBytes, { flag: "wx", mode: 0o600 });
      return { path: outputPath, sizeBytes: base.archiveBytes.length, sha256: createHash("sha256").update(base.archiveBytes).digest("hex") };
    });
    const harness = coordinatorHarness(api, { machineDir: base.machineDir, buildBundle, transport: base.transport });

    const active = harness.instance.collect(command());
    await expect(harness.instance.collect(command({ reportId: "dbr_report_2" }))).resolves.toEqual({
      status: "failed",
      failureCode: "collector_busy",
    });
    release();
    await expect(active).resolves.toEqual({ status: "uploaded" });
    expect(buildBundle).toHaveBeenCalledTimes(1);
    expect(base.transport.fail).toHaveBeenCalledWith("dbr_report_2", "collector_busy");
  });

  it("durably writes sidecars with random same-directory wx/0600 temp files before rename and directory fsync", async () => {
    const api = await loadSubject();
    const operations: Array<{ op: string; path?: string; flags?: string; mode?: number }> = [];
    let suffix = 0;
    const fsOps = {
      randomSuffix: vi.fn(() => `nonce-${++suffix}`),
      open: vi.fn((path: string, flags: "wx" | "r" | "r+", mode?: number) => {
        operations.push({ op: "open", path, flags, mode });
        return openSync(path, flags, mode);
      }),
      write: vi.fn((fd: number, bytes: Uint8Array) => {
        operations.push({ op: "write" });
        writeSync(fd, bytes);
      }),
      fsync: vi.fn((fd: number) => {
        operations.push({ op: "fsync" });
        fsyncSync(fd);
      }),
      close: vi.fn((fd: number) => {
        operations.push({ op: "close" });
        closeSync(fd);
      }),
      rename: vi.fn((from: string, to: string) => {
        operations.push({ op: "rename", path: `${from}->${to}` });
        renameSync(from, to);
      }),
      fsyncDirectory: vi.fn((path: string) => {
        operations.push({ op: "fsyncDirectory", path });
        if (process.platform === "win32") return;
        const fd = openSync(path, "r");
        try { fsyncSync(fd); } finally { closeSync(fd); }
      }),
    };
    const bundleTemps: string[] = [];
    const bytes = Buffer.from("durable-bytes");
    const harness = coordinatorHarness(api, {
      fsOps,
      buildBundle: vi.fn(async ({ outputPath }) => {
        bundleTemps.push(outputPath);
        writeFileSync(outputPath, bytes, { flag: "wx", mode: 0o600 });
        return { path: outputPath, sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
      }),
    });
    await harness.instance.collect(command());

    const exclusiveOpens = operations.filter((operation) => operation.op === "open" && operation.flags === "wx");
    expect(exclusiveOpens).toHaveLength(2);
    expect(exclusiveOpens.every((operation) => operation.mode === 0o600)).toBe(true);
    const archiveOpen = operations.find((operation) => operation.op === "open" && operation.flags === "r+");
    expect(archiveOpen?.path).toBe(bundleTemps[0]);
    const archiveOpenIndex = operations.indexOf(archiveOpen!);
    expect(operations.slice(archiveOpenIndex, archiveOpenIndex + 4).map(({ op }) => op)).toEqual([
      "open",
      "fsync",
      "close",
      "rename",
    ]);
    expect(harness.uploaded).toEqual([{
      meta: {
        reportId: "dbr_report_1",
        sizeBytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
      bytes,
    }]);
    const tempPaths = [...exclusiveOpens.map((operation) => operation.path!), ...bundleTemps];
    expect(new Set(tempPaths).size).toBe(tempPaths.length);
    expect(tempPaths.every((path) => dirname(path) === diagnosticsDir(harness.machineDir))).toBe(true);

    const names = operations.map((operation) => operation.op);
    let cursor = 0;
    for (let writeIndex = 0; writeIndex < 2; writeIndex += 1) {
      const expected = ["open", "write", "fsync", "close", "rename", "fsyncDirectory"];
      const actual: string[] = [];
      for (; cursor < names.length && actual.length < expected.length; cursor += 1) {
        if (names[cursor] === expected[actual.length]) actual.push(names[cursor]!);
      }
      expect(actual).toEqual(expected);
    }
  });

  it("never reuses a colliding fixed temp or follows its symlink target", async () => {
    const api = await loadSubject();
    const machineDir = tempDir();
    const outside = join(machineDir, "outside-target");
    writeFileSync(outside, "must-survive");
    const suffixes = ["collision", "fresh-1", "fresh-2", "fresh-3"];
    let firstExclusivePath: string | null = null;
    const fsOps = {
      randomSuffix: vi.fn(() => suffixes.shift() ?? `fresh-${Date.now()}`),
      open: vi.fn((path: string, flags: "wx" | "r" | "r+", mode?: number) => {
        if (flags === "wx" && firstExclusivePath === null) {
          firstExclusivePath = path;
          symlinkSync(outside, path);
        }
        return openSync(path, flags, mode);
      }),
      write: (fd: number, bytes: Uint8Array) => { writeSync(fd, bytes); },
      fsync: (fd: number) => { fsyncSync(fd); },
      close: (fd: number) => { closeSync(fd); },
      rename: (from: string, to: string) => { renameSync(from, to); },
      fsyncDirectory: (path: string) => {
        if (process.platform === "win32") return;
        const fd = openSync(path, "r");
        try { fsyncSync(fd); } finally { closeSync(fd); }
      },
    };
    const harness = coordinatorHarness(api, { machineDir, fsOps });
    await expect(harness.instance.collect(command())).resolves.toEqual({ status: "uploaded" });
    expect(fsOps.randomSuffix.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(readFileSync(outside, "utf8")).toBe("must-survive");
    expect(firstExclusivePath).not.toBeNull();
    expect(lstatSync(firstExclusivePath!).isSymbolicLink()).toBe(true);
  });

  it("freezes every filesystem and upload crash checkpoint", async () => {
    const api = await loadSubject();
    expect(api.DIAGNOSTIC_COORDINATOR_CRASH_POINTS).toEqual([
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
    ]);

    for (const point of api.DIAGNOSTIC_COORDINATOR_CRASH_POINTS) {
      const machineDir = tempDir();
      const firstBytes = Buffer.from(`first-archive-${point}`);
      const resumedBytes = Buffer.from(`resumed-archive-${point}`);
      const first = coordinatorHarness(api, {
        machineDir,
        archiveBytes: firstBytes,
        checkpoint: (seen) => {
          if (seen === point) throw new Error(`simulated crash at ${point}`);
        },
      });
      await expect(first.instance.collect(command())).rejects.toThrow(`simulated crash at ${point}`);

      const resumed = coordinatorHarness(api, { machineDir, archiveBytes: resumedBytes });
      await resumed.instance.recover();
      if (point === "collecting_temp_written" || point === "collecting_temp_fsynced") {
        expect(resumed.buildBundle).not.toHaveBeenCalled();
        expect(resumed.uploaded).toHaveLength(0);
        await resumed.instance.collect(command());
      }
      const committedArchiveBoundary = [
        "archive_renamed",
        "archive_dir_fsynced",
        "ready_temp_written",
        "ready_temp_fsynced",
        "ready_renamed",
        "ready_dir_fsynced",
        "before_upload",
        "after_upload",
      ].includes(point);
      expect(resumed.buildBundle).toHaveBeenCalledTimes(committedArchiveBoundary ? 0 : 1);
      expect(resumed.uploaded).toHaveLength(1);
      expect(resumed.uploaded[0]?.bytes).toEqual(committedArchiveBoundary ? firstBytes : resumedBytes);
    }
  });

  it("promotes archive-renamed plus collecting-sidecar recovery and reuses exact size/SHA/bytes", async () => {
    const api = await loadSubject();
    const machineDir = tempDir();
    const first = coordinatorHarness(api, {
      machineDir,
      checkpoint: (point) => {
        if (point === "archive_renamed") throw new Error("crash after archive rename");
      },
    });
    await expect(first.instance.collect(command())).rejects.toThrow("crash after archive rename");
    const committed = readFileSync(archivePath(machineDir));
    const collecting = JSON.parse(readFileSync(sidecarPath(machineDir), "utf8")) as Record<string, unknown>;
    expect(collecting.phase).toBe("collecting");

    const resumed = coordinatorHarness(api, { machineDir });
    await resumed.instance.recover();
    expect(resumed.buildBundle).not.toHaveBeenCalled();
    expect(resumed.uploaded[0]).toEqual({
      meta: {
        reportId: "dbr_report_1",
        sizeBytes: committed.length,
        sha256: createHash("sha256").update(committed).digest("hex"),
      },
      bytes: committed,
    });
  });

  it("promotes archive-renamed state on an exact duplicate command and rejects persisted metadata mismatch", async () => {
    const api = await loadSubject();
    const exactDir = tempDir();
    const first = coordinatorHarness(api, {
      machineDir: exactDir,
      archiveBytes: Buffer.from("committed-once"),
      checkpoint: (point) => {
        if (point === "archive_renamed") throw new Error("crash at same-byte boundary");
      },
    });
    await expect(first.instance.collect(command())).rejects.toThrow("crash at same-byte boundary");
    const committed = readFileSync(archivePath(exactDir));

    const duplicate = coordinatorHarness(api, { machineDir: exactDir, archiveBytes: Buffer.from("must-not-build") });
    await expect(duplicate.instance.collect(command())).resolves.toEqual({ status: "uploaded" });
    expect(duplicate.buildBundle).not.toHaveBeenCalled();
    expect(duplicate.uploaded[0]?.bytes).toEqual(committed);

    const mismatchDir = tempDir();
    const mismatchFirst = coordinatorHarness(api, {
      machineDir: mismatchDir,
      checkpoint: (point) => {
        if (point === "archive_renamed") throw new Error("crash before mismatch");
      },
    });
    await expect(mismatchFirst.instance.collect(command())).rejects.toThrow("crash before mismatch");
    const mismatch = coordinatorHarness(api, { machineDir: mismatchDir });
    await expect(mismatch.instance.collect(command({ fromMs: 999 }))).resolves.toEqual({
      status: "failed",
      failureCode: "local_artifact_invalid",
    });
    expect(mismatch.buildBundle).not.toHaveBeenCalled();
    expect(mismatch.transport.upload).not.toHaveBeenCalled();
    expect(mismatch.transport.fail).toHaveBeenCalledWith("dbr_report_1", "local_artifact_invalid");
  });

  it("retains one exact artifact across exponential retry exhaustion and the next scheduled round", async () => {
    const api = await loadSubject();
    const bodies: Buffer[] = [];
    const transport: DiagnosticTransport = {
      upload: vi.fn(async (_meta, body): Promise<TransportResult> => {
        bodies.push(await streamBytes(body));
        return bodies.length <= 3 ? { kind: "retryable" } : { kind: "terminal", status: "uploaded" };
      }),
      fail: vi.fn(async (): Promise<TransportResult> => ({ kind: "terminal", status: "failed" })),
    };
    const sleep = vi.fn(async (_delayMs: number) => {});
    const harness = coordinatorHarness(api, { transport, sleep });

    await expect(harness.instance.collect(command())).resolves.toEqual({ status: "pending" });
    expect(harness.buildBundle).toHaveBeenCalledTimes(1);
    expect(bodies).toHaveLength(3);
    expect(bodies.every((bytes) => bytes.equals(harness.archiveBytes))).toBe(true);
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([10, 20]);
    expect(harness.scheduled.map(({ delayMs }) => delayMs)).toEqual([40]);
    expect(existsSync(archivePath(harness.machineDir))).toBe(true);
    expect(existsSync(sidecarPath(harness.machineDir))).toBe(true);

    await harness.scheduled[0]!.task();
    expect(harness.buildBundle).toHaveBeenCalledTimes(1);
    expect(bodies).toHaveLength(4);
    expect(bodies[3]).toEqual(harness.archiveBytes);
    expect(existsSync(archivePath(harness.machineDir))).toBe(false);
    expect(existsSync(sidecarPath(harness.machineDir))).toBe(false);
  });

  it("fails missing, wrong-size, and same-size wrong-SHA ready artifacts independently without recollecting", async () => {
    const api = await loadSubject();
    const original = Buffer.from("archive-original");
    for (const branch of ["missing", "wrong-size", "wrong-sha"] as const) {
      const machineDir = tempDir();
      const dir = diagnosticsDir(machineDir);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(sidecarPath(machineDir), JSON.stringify({
        schemaVersion: 1,
        phase: "ready",
        reportId: "dbr_report_1",
        agentId: "agent-1",
        fromMs: 1000,
        deadlineAt: 86_401_000,
        sizeBytes: original.length,
        sha256: createHash("sha256").update(original).digest("hex"),
      }), { mode: 0o600 });
      if (branch === "wrong-size") writeFileSync(archivePath(machineDir), "different-size");
      if (branch === "wrong-sha") writeFileSync(archivePath(machineDir), Buffer.from("archive-originaL"));
      const harness = coordinatorHarness(api, { machineDir });

      await harness.instance.recover();
      expect(harness.buildBundle, branch).not.toHaveBeenCalled();
      expect(harness.transport.upload, branch).not.toHaveBeenCalled();
      expect(harness.transport.fail, branch).toHaveBeenCalledWith("dbr_report_1", "local_artifact_invalid");
      expect(existsSync(archivePath(machineDir)), branch).toBe(false);
      expect(existsSync(sidecarPath(machineDir)), branch).toBe(false);
    }
  });

  it("retains invalid artifacts across retryable failure PATCH and resumes the durable fail intent", async () => {
    const api = await loadSubject();
    for (const resumeKind of ["scheduled", "restart"] as const) {
      const machineDir = tempDir();
      const dir = diagnosticsDir(machineDir);
      const original = Buffer.from("archive-original");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(sidecarPath(machineDir), JSON.stringify({
        schemaVersion: 1,
        phase: "ready",
        reportId: "dbr_report_1",
        agentId: "agent-1",
        fromMs: 1000,
        deadlineAt: 86_401_000,
        sizeBytes: original.length,
        sha256: createHash("sha256").update(original).digest("hex"),
      }), { mode: 0o600 });
      writeFileSync(archivePath(machineDir), Buffer.from("archive-originaL"), { mode: 0o600 });
      let calls = 0;
      const first = coordinatorHarness(api, {
        machineDir,
        retry: { maxAttemptsPerRound: 1, baseDelayMs: 10, maxDelayMs: 10 },
        transport: {
          upload: vi.fn(async (): Promise<TransportResult> => ({ kind: "retryable" })),
          fail: vi.fn(async (): Promise<TransportResult> => {
            calls += 1;
            return resumeKind === "scheduled" && calls > 1
              ? { kind: "terminal", status: "failed" }
              : { kind: "retryable" };
          }),
        },
      });
      await first.instance.recover();
      expect(existsSync(sidecarPath(machineDir)), resumeKind).toBe(true);
      expect(existsSync(archivePath(machineDir)), resumeKind).toBe(true);

      if (resumeKind === "scheduled") {
        expect(first.scheduled).toHaveLength(1);
        await first.scheduled[0]!.task();
      } else {
        await first.instance.shutdown();
        const resumed = coordinatorHarness(api, { machineDir });
        await resumed.instance.recover();
        expect(resumed.transport.fail).toHaveBeenCalledWith("dbr_report_1", "local_artifact_invalid");
      }
      expect(existsSync(sidecarPath(machineDir)), resumeKind).toBe(false);
      expect(existsSync(archivePath(machineDir)), resumeKind).toBe(false);
    }
  });

  it("treats attributable corrupt sidecars as invalid, ignores embedded paths, and leaves unknown files untouched", async () => {
    const api = await loadSubject();
    const machineDir = tempDir();
    const dir = diagnosticsDir(machineDir);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const outside = join(machineDir, "outside-secret");
    writeFileSync(outside, "must-survive");
    writeFileSync(sidecarPath(machineDir), JSON.stringify({
      schemaVersion: 1,
      phase: "ready",
      reportId: "dbr_report_1",
      archivePath: outside,
      credential: "cmk_SECRET",
    }), { mode: 0o600 });
    writeFileSync(join(dir, "unknown-user-file"), "untouched");
    const warn = vi.fn();
    const harness = coordinatorHarness(api, { machineDir, logger: { warn } });

    await harness.instance.recover();
    expect(harness.buildBundle).not.toHaveBeenCalled();
    expect(harness.transport.fail).toHaveBeenCalledWith("dbr_report_1", "local_artifact_invalid");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("diagnostic local artifact invalid", {
      reportId: "dbr_report_1",
      code: "local_artifact_invalid",
    });
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/outside-secret|cmk_SECRET|archivePath|credential/);
    expect(existsSync(sidecarPath(machineDir))).toBe(false);
    expect(readFileSync(outside, "utf8")).toBe("must-survive");
    expect(readFileSync(join(dir, "unknown-user-file"), "utf8")).toBe("untouched");
  });

  it("never overwrites an attributable committed archive that has no sidecar", async () => {
    const api = await loadSubject();
    const machineDir = tempDir();
    mkdirSync(diagnosticsDir(machineDir), { recursive: true, mode: 0o700 });
    writeFileSync(archivePath(machineDir), "already-committed-exact-bytes", { mode: 0o600 });
    const harness = coordinatorHarness(api, { machineDir });

    await harness.instance.recover();
    expect(harness.buildBundle).not.toHaveBeenCalled();
    expect(harness.transport.upload).not.toHaveBeenCalled();
    expect(harness.transport.fail).toHaveBeenCalledWith("dbr_report_1", "local_artifact_invalid");
    expect(existsSync(archivePath(machineDir))).toBe(false);
  });

  it("rejects symlinked artifacts without touching their targets", async () => {
    const api = await loadSubject();
    const machineDir = tempDir();
    const dir = diagnosticsDir(machineDir);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const outside = join(machineDir, "outside-archive");
    writeFileSync(outside, "outside-bytes");
    symlinkSync(outside, archivePath(machineDir));
    writeFileSync(sidecarPath(machineDir), JSON.stringify({
      schemaVersion: 1,
      phase: "ready",
      reportId: "dbr_report_1",
      agentId: "agent-1",
      fromMs: 1000,
      deadlineAt: 86_401_000,
      sizeBytes: 13,
      sha256: createHash("sha256").update("outside-bytes").digest("hex"),
    }), { mode: 0o600 });
    const harness = coordinatorHarness(api, { machineDir });

    await harness.instance.recover();
    expect(harness.transport.upload).not.toHaveBeenCalled();
    expect(harness.transport.fail).toHaveBeenCalledWith("dbr_report_1", "local_artifact_invalid");
    expect(readFileSync(outside, "utf8")).toBe("outside-bytes");
  });

  it("uses private modes and deletes only exact regular artifacts after confirmed terminal", async () => {
    const api = await loadSubject();
    const machineDir = tempDir();
    let archiveMode = 0;
    let sidecarMode = 0;
    const harness = coordinatorHarness(api, {
      machineDir,
      checkpoint: (point) => {
        if (point === "ready_dir_fsynced") {
          archiveMode = statSync(archivePath(machineDir)).mode & 0o777;
          sidecarMode = statSync(sidecarPath(machineDir)).mode & 0o777;
          writeFileSync(join(diagnosticsDir(machineDir), "unknown-user-file"), "keep");
        }
      },
    });
    await harness.instance.collect(command());
    if (process.platform !== "win32") {
      expect(lstatSync(diagnosticsDir(machineDir)).mode & 0o777).toBe(0o700);
      expect(archiveMode).toBe(0o600);
      expect(sidecarMode).toBe(0o600);
    }
    expect(readFileSync(join(diagnosticsDir(machineDir), "unknown-user-file"), "utf8")).toBe("keep");
    expect(existsSync(archivePath(machineDir))).toBe(false);
    expect(existsSync(sidecarPath(machineDir))).toBe(false);
  });

  it("cleans attributable artifacts at the deadline without upload, failure PATCH, or recollection", async () => {
    const api = await loadSubject();
    const machineDir = tempDir();
    const first = coordinatorHarness(api, {
      machineDir,
      transport: {
        upload: vi.fn(async (_meta, body): Promise<TransportResult> => {
          await streamBytes(body);
          return { kind: "retryable" };
        }),
        fail: vi.fn(async (): Promise<TransportResult> => ({ kind: "terminal", status: "failed" })),
      },
      retry: { maxAttemptsPerRound: 1, baseDelayMs: 10, maxDelayMs: 10 },
    });
    await expect(first.instance.collect(command({ deadlineAt: 3000 }))).resolves.toEqual({ status: "pending" });
    expect(existsSync(archivePath(machineDir))).toBe(true);

    const expired = coordinatorHarness(api, { machineDir, now: () => 3000 });
    await expired.instance.recover();
    expect(expired.buildBundle).not.toHaveBeenCalled();
    expect(expired.transport.upload).not.toHaveBeenCalled();
    expect(expired.transport.fail).not.toHaveBeenCalled();
    expect(existsSync(archivePath(machineDir))).toBe(false);
    expect(existsSync(sidecarPath(machineDir))).toBe(false);
  });

  it("shutdown cancels scheduled retry and prevents its task from uploading or deleting ambiguous artifacts", async () => {
    const api = await loadSubject();
    const transport: DiagnosticTransport = {
      upload: vi.fn(async (_meta, body): Promise<TransportResult> => {
        await streamBytes(body);
        return { kind: "retryable" };
      }),
      fail: vi.fn(async (): Promise<TransportResult> => ({ kind: "retryable" })),
    };
    const harness = coordinatorHarness(api, {
      transport,
      retry: { maxAttemptsPerRound: 1, baseDelayMs: 10, maxDelayMs: 10 },
    });
    await expect(harness.instance.collect(command())).resolves.toEqual({ status: "pending" });
    expect(harness.scheduled).toHaveLength(1);
    expect(transport.upload).toHaveBeenCalledTimes(1);

    await harness.instance.shutdown();
    expect(harness.scheduled[0]?.cancelled).toBe(true);
    const buildCountAtShutdown = vi.mocked(harness.buildBundle).mock.calls.length;
    await harness.scheduled[0]!.task();
    expect(transport.upload).toHaveBeenCalledTimes(1);
    expect(transport.fail).not.toHaveBeenCalled();
    expect(harness.buildBundle).toHaveBeenCalledTimes(buildCountAtShutdown);
    await expect(harness.instance.collect(command({ reportId: "dbr_report_2" }))).rejects.toMatchObject({
      code: "coordinator_shutdown",
    });
    await expect(harness.instance.recover()).rejects.toMatchObject({ code: "coordinator_shutdown" });
    expect(transport.upload).toHaveBeenCalledTimes(1);
    expect(transport.fail).not.toHaveBeenCalled();
    expect(harness.buildBundle).toHaveBeenCalledTimes(buildCountAtShutdown);
    expect(existsSync(archivePath(harness.machineDir))).toBe(true);
    expect(existsSync(sidecarPath(harness.machineDir))).toBe(true);
  });

  it("never follows an unsafe diagnostics directory and never scans outside the machine directory", async () => {
    const api = await loadSubject();
    const machineDir = tempDir();
    const outside = tempDir();
    writeFileSync(join(outside, "report-dbr_report_1.json"), "outside-sidecar");
    symlinkSync(outside, diagnosticsDir(machineDir));
    const harness = coordinatorHarness(api, { machineDir });

    await expect(harness.instance.recover()).rejects.toMatchObject({ code: "local_artifact_invalid" });
    expect(readFileSync(join(outside, "report-dbr_report_1.json"), "utf8")).toBe("outside-sidecar");
    expect(harness.transport.upload).not.toHaveBeenCalled();
    expect(harness.transport.fail).not.toHaveBeenCalled();
  });
});
