import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRotatingFileSink,
  type RotatingFileSink,
} from "../util/rotatingFileSink.js";

type SnapshotSourceName = "daemon_log" | "fsm_trace";
type SnapshotWarningCode =
  | "source_unavailable"
  | "malformed_json"
  | "line_too_long"
  | "incomplete_tail"
  | "invalid_timestamp";

interface SnapshotRow {
  source: SnapshotSourceName;
  timeMs: number;
  ordinal: number;
  value: Record<string, unknown>;
}

interface SnapshotReadResult {
  rows: SnapshotRow[];
  warnings: SnapshotWarningCode[];
  droppedRows: number;
}

interface SnapshotReaderModule {
  readSnapshotJsonLines(args: {
    source: Pick<RotatingFileSink, "openSnapshot">;
    sourceName: SnapshotSourceName;
    fromMs: number;
    maxLineBytes: number;
    timestampOf: (value: Record<string, unknown>) => number | null;
  }): Promise<SnapshotReadResult>;
  mergeChronologicalSnapshotRows(inputs: readonly SnapshotRow[][]): SnapshotRow[];
  readPinnedJsonFile(args: {
    path: string;
    maxBytes: number;
  }): Promise<{ value: unknown | null; warnings: SnapshotWarningCode[] }>;
}

async function loadSubject(): Promise<SnapshotReaderModule> {
  return vi.importActual<SnapshotReaderModule>("./snapshotReader.js");
}

function line(id: string, timeMs: number): string {
  return JSON.stringify({ id, timeMs });
}

function timestampOf(value: Record<string, unknown>): number | null {
  return typeof value.timeMs === "number" ? value.timeMs : null;
}

const dirs = new Set<string>();

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "diagnostics-snapshot-"));
  dirs.add(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.clear();
});

describe("B2c snapshot reader", () => {
  it("opens the existing rotating sink snapshot synchronously and survives A/B/C rotation", async () => {
    const api = await loadSubject();
    const path = join(tempDir(), "daemon.log");
    const sink = createRotatingFileSink(path, 30, { mode: 0o600, hardMaxBytes: true });
    sink.write(line("A", 100));
    sink.write(line("B", 200));
    expect(readFileSync(`${path}.1`, "utf8")).toBe(`${line("A", 100)}\n`);
    expect(readFileSync(path, "utf8")).toBe(`${line("B", 200)}\n`);
    const openSnapshot = vi.spyOn(sink, "openSnapshot");

    const pending = api.readSnapshotJsonLines({
      source: sink,
      sourceName: "daemon_log",
      fromMs: 0,
      maxLineBytes: 1024,
      timestampOf,
    });

    expect(openSnapshot).toHaveBeenCalledTimes(1);
    sink.write(line("C", 300));
    const result = await pending;
    const ids = result.rows.map((row) => row.value.id);

    expect(ids).toEqual(["A", "B"]);
    expect(ids).not.toEqual(["A", "C"]);
  });

  it("closes every pinned fd in finally on success and timestamp failure", async () => {
    const api = await loadSubject();
    const path = join(tempDir(), "source.jsonl");
    writeFileSync(path, `${line("one", 100)}\n`);

    const makeSource = () => {
      const fd = openSync(path, "r");
      const close = vi.fn(() => closeSync(fd));
      return {
        source: {
          openSnapshot: () => ({
            files: [{ path, fd, size: statSync(path).size }],
            close,
          }),
        },
        close,
      };
    };

    const successful = makeSource();
    await api.readSnapshotJsonLines({
      source: successful.source,
      sourceName: "daemon_log",
      fromMs: 0,
      maxLineBytes: 1024,
      timestampOf,
    });
    expect(successful.close).toHaveBeenCalledTimes(1);

    const failed = makeSource();
    const result = await api.readSnapshotJsonLines({
      source: failed.source,
      sourceName: "daemon_log",
      fromMs: 0,
      maxLineBytes: 1024,
      timestampOf: () => {
        throw new Error("HOSTILE_TIMESTAMP_DETAIL");
      },
    });
    expect(failed.close).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ rows: [], warnings: ["invalid_timestamp"], droppedRows: 1 });
    expect(JSON.stringify(result)).not.toContain("HOSTILE_TIMESTAMP_DETAIL");
  });

  it("reports a missing rotating source without inventing rows", async () => {
    const api = await loadSubject();
    const path = join(tempDir(), "missing.log");
    expect(existsSync(path)).toBe(false);
    const source = createRotatingFileSink(path, 4096, { mode: 0o600, hardMaxBytes: true });
    await expect(api.readSnapshotJsonLines({
      source,
      sourceName: "daemon_log",
      fromMs: 0,
      maxLineBytes: 1024,
      timestampOf,
    })).resolves.toEqual({ rows: [], warnings: ["source_unavailable"], droppedRows: 0 });
  });

  it("pins active size so appends after openSnapshot are never read", async () => {
    const api = await loadSubject();
    const path = join(tempDir(), "fsm-trace.jsonl");
    const sink = createRotatingFileSink(path, 1024 * 1024, { mode: 0o600, hardMaxBytes: true });
    sink.write(line("before", 100));

    const pending = api.readSnapshotJsonLines({
      source: sink,
      sourceName: "fsm_trace",
      fromMs: 0,
      maxLineBytes: 1024,
      timestampOf,
    });
    sink.write(line("after", 200));

    await expect(pending).resolves.toMatchObject({
      rows: [expect.objectContaining({ value: expect.objectContaining({ id: "before" }) })],
    });
  });

  it("drops malformed and oversize lines and reports an incomplete pinned tail", async () => {
    const api = await loadSubject();
    const path = join(tempDir(), "daemon.log");
    writeFileSync(path, [
      line("valid", 100),
      "{broken",
      JSON.stringify({ id: "oversize", timeMs: 200, text: "x".repeat(200) }),
      JSON.stringify({ id: "partial", timeMs: 300 }),
    ].join("\n"));
    const source = createRotatingFileSink(path, 4096, { mode: 0o600, hardMaxBytes: true });

    const result = await api.readSnapshotJsonLines({
      source,
      sourceName: "daemon_log",
      fromMs: 0,
      maxLineBytes: 80,
      timestampOf,
    });

    expect(result.rows.map((row) => row.value.id)).toEqual(["valid"]);
    expect(result.warnings).toEqual(["malformed_json", "line_too_long", "incomplete_tail"]);
    expect(result.droppedRows).toBe(3);
  });

  it("rejects symlink and FIFO generations without following or blocking", async () => {
    const api = await loadSubject();
    const dir = tempDir();
    const outside = join(dir, "outside.log");
    writeFileSync(outside, `${line("secret", 100)}\n`);
    const link = join(dir, "daemon.log");
    symlinkSync(outside, link);
    const linked = createRotatingFileSink(link, 4096, { mode: 0o600, hardMaxBytes: true });

    const linkedResult = await api.readSnapshotJsonLines({
      source: linked,
      sourceName: "daemon_log",
      fromMs: 0,
      maxLineBytes: 1024,
      timestampOf,
    });
    expect(linkedResult.rows).toEqual([]);
    expect(linkedResult.warnings).toEqual(["source_unavailable"]);

    if (process.platform === "win32") return;
    const fifoPath = join(dir, "fsm-trace.jsonl");
    execFileSync("mkfifo", [fifoPath]);
    const fifo = createRotatingFileSink(fifoPath, 4096, { mode: 0o600, hardMaxBytes: true });
    const fifoResult = await api.readSnapshotJsonLines({
      source: fifo,
      sourceName: "fsm_trace",
      fromMs: 0,
      maxLineBytes: 1024,
      timestampOf,
    });
    expect(fifoResult.rows).toEqual([]);
    expect(fifoResult.warnings).toEqual(["source_unavailable"]);
  });

  it("uses an inclusive 24-hour cutoff and drops rows without a finite safe timestamp", async () => {
    const api = await loadSubject();
    const path = join(tempDir(), "fsm-trace.jsonl");
    const sink = createRotatingFileSink(path, 4096, { mode: 0o600, hardMaxBytes: true });
    sink.write(line("old", 999));
    sink.write(line("boundary", 1000));
    sink.write(line("new", 1001));
    sink.write(JSON.stringify({ id: "nan", timeMs: "1002" }));
    sink.write(JSON.stringify({ id: "unsafe", timeMs: Number.MAX_SAFE_INTEGER + 1 }));

    const result = await api.readSnapshotJsonLines({
      source: sink,
      sourceName: "fsm_trace",
      fromMs: 1000,
      maxLineBytes: 1024,
      timestampOf,
    });

    expect(result.rows.map((row) => row.value.id)).toEqual(["boundary", "new"]);
    expect(result.droppedRows).toBe(3);
  });

  it("k-way merges rotated sources chronologically with deterministic source and ordinal ties", async () => {
    const api = await loadSubject();
    const dir = tempDir();
    const log = createRotatingFileSink(join(dir, "daemon.log"), 4096, { mode: 0o600, hardMaxBytes: true });
    const fsm = createRotatingFileSink(join(dir, "fsm-trace.jsonl"), 4096, { mode: 0o600, hardMaxBytes: true });
    log.write(line("log-100", 100));
    log.write(line("log-300-a", 300));
    log.write(line("log-300-b", 300));
    fsm.write(line("fsm-200", 200));
    fsm.write(line("fsm-300", 300));

    const [logRows, fsmRows] = await Promise.all([
      api.readSnapshotJsonLines({ source: log, sourceName: "daemon_log", fromMs: 0, maxLineBytes: 1024, timestampOf }),
      api.readSnapshotJsonLines({ source: fsm, sourceName: "fsm_trace", fromMs: 0, maxLineBytes: 1024, timestampOf }),
    ]);
    const merged = api.mergeChronologicalSnapshotRows([logRows.rows, fsmRows.rows]);

    expect(merged.map((row) => row.value.id)).toEqual([
      "log-100",
      "fsm-200",
      "log-300-a",
      "log-300-b",
      "fsm-300",
    ]);
  });

  it("pins status.json with no-follow, a fixed size, and a strict byte cap", async () => {
    const api = await loadSubject();
    const dir = tempDir();
    const statusPath = join(dir, "status.json");
    writeFileSync(statusPath, JSON.stringify({ writtenAt: 100, agents: [] }));
    const pending = api.readPinnedJsonFile({ path: statusPath, maxBytes: 1024 });
    appendFileSync(statusPath, "HOSTILE_TRAILING_BYTES");
    await expect(pending).resolves.toEqual({
      value: { writtenAt: 100, agents: [] },
      warnings: [],
    });

    const linkPath = join(dir, "status-link.json");
    symlinkSync(statusPath, linkPath);
    await expect(api.readPinnedJsonFile({ path: linkPath, maxBytes: 1024 })).resolves.toEqual({
      value: null,
      warnings: ["source_unavailable"],
    });
    await expect(api.readPinnedJsonFile({ path: statusPath, maxBytes: 4 })).resolves.toEqual({
      value: null,
      warnings: ["line_too_long"],
    });
  });
});
