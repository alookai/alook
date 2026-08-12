import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";

interface DiagnosticEventRow {
  recordType: "daemon_log" | "fsm";
  timeMs: number;
  [key: string]: unknown;
}

interface BundleArtifact {
  path: string;
  sizeBytes: number;
  sha256: string;
  uncompressedBytes: number;
}

interface BundleModule {
  DIAGNOSTIC_NDJSON_MAX_BYTES: number;
  DIAGNOSTIC_GZIP_MAX_BYTES: number;
  buildDiagnosticBundle(args: {
    outputPath: string;
    header: Record<string, unknown>;
    status: Record<string, unknown> | null;
    events: AsyncIterable<DiagnosticEventRow> | Iterable<DiagnosticEventRow>;
    sourceWarnings?: readonly string[];
    sourceDroppedRows?: Readonly<Record<string, number>>;
    maxUncompressedBytes?: number;
    maxCompressedBytes?: number;
  }): Promise<BundleArtifact>;
}

async function loadSubject(): Promise<BundleModule> {
  return vi.importActual<BundleModule>("./bundle.js");
}

const dirs = new Set<string>();

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "diagnostics-bundle-"));
  dirs.add(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.clear();
});

function decode(path: string): { bytes: Buffer; rows: Array<Record<string, unknown>> } {
  const compressed = readFileSync(path);
  const bytes = gunzipSync(compressed);
  return {
    bytes,
    rows: bytes.toString("utf8").trimEnd().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

function header(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    recordType: "bundle_header",
    schemaVersion: 1,
    reportId: "dbr_report_1",
    agentId: "target-agent",
    machineId: "machine-1",
    capturedAt: 2000,
    fromMs: 1000,
    deadlineAt: 3000,
    ...extra,
  };
}

function event(source: "daemon_log" | "fsm", id: string, timeMs: number, payload = "x"): DiagnosticEventRow {
  return { recordType: source, id, timeMs, payload };
}

describe("B2c bounded gzip NDJSON bundle", () => {
  it("writes the exact header/status/events/footer order and a recomputable footer", async () => {
    const api = await loadSubject();
    const outputPath = join(tempDir(), "report.ndjson.gz");
    const artifact = await api.buildDiagnosticBundle({
      outputPath,
      header: header(),
      status: { recordType: "status", timeMs: 1500, agentId: "target-agent", status: "running" },
      events: [event("daemon_log", "log-1", 1600), event("fsm", "fsm-1", 1700)],
      sourceWarnings: ["malformed_json", "incomplete_tail"],
      sourceDroppedRows: { daemon_log: 2, fsm: 1 },
    });
    const decoded = decode(outputPath);

    expect(decoded.rows.map((row) => row.recordType)).toEqual([
      "bundle_header",
      "status",
      "daemon_log",
      "fsm",
      "bundle_footer",
    ]);
    expect(decoded.rows[0]).toEqual({
      recordType: "bundle_header",
      schemaVersion: 1,
      reportId: "dbr_report_1",
      agentId: "target-agent",
      machineId: "machine-1",
      capturedAt: 2000,
      fromMs: 1000,
      deadlineAt: 3000,
    });
    expect(decoded.rows.at(-1)).toEqual({
      recordType: "bundle_footer",
      earliestAt: 1500,
      latestAt: 1700,
      counts: { status: 1, daemon_log: 1, fsm: 1 },
      missingSources: [],
      warnings: ["malformed_json", "incomplete_tail"],
      droppedRows: { daemon_log: 2, fsm: 1 },
      truncated: false,
      uncompressedBytes: decoded.bytes.byteLength,
    });
    expect(decoded.bytes.at(-1)).toBe(0x0a);
    expect(artifact).toEqual({
      path: outputPath,
      sizeBytes: statSync(outputPath).size,
      sha256: createHash("sha256").update(readFileSync(outputPath)).digest("hex"),
      uncompressedBytes: decoded.bytes.byteLength,
    });
  });

  it("accounts for missing sources with fixed codes and never serializes source paths or exception text", async () => {
    const api = await loadSubject();
    const outputPath = join(tempDir(), "missing.ndjson.gz");
    await api.buildDiagnosticBundle({
      outputPath,
      header: header(),
      status: null,
      events: [],
      sourceWarnings: ["daemon_log_missing", "fsm_trace_missing", "status_missing"],
    });
    const encoded = decode(outputPath).bytes.toString("utf8");
    const footer = JSON.parse(encoded.trimEnd().split("\n").at(-1)!) as Record<string, unknown>;
    expect(footer).toMatchObject({
      missingSources: ["daemon_log", "fsm_trace", "status"],
      warnings: ["daemon_log_missing", "fsm_trace_missing", "status_missing"],
    });
    expect(encoded).not.toMatch(/\/Users\/|\/home\/|daemon\.log|fsm-trace\.jsonl|Error:|stack/);
  });

  it("makes invalid internal event timestamps visible in the footer", async () => {
    const api = await loadSubject();
    const outputPath = join(tempDir(), "invalid-event-time.ndjson.gz");
    const missingTime = event("fsm", "missing", 1500);
    Reflect.deleteProperty(missingTime, "timeMs");
    await api.buildDiagnosticBundle({
      outputPath,
      header: header(),
      status: null,
      events: [
        event("fsm", "nan", Number.NaN),
        event("fsm", "fractional", 1500.5),
        event("fsm", "negative", -1),
        missingTime,
      ],
      sourceDroppedRows: { fsm: 3 },
    });

    const rows = decode(outputPath).rows;
    expect(rows.map((row) => row.recordType)).toEqual(["bundle_header", "bundle_footer"]);
    expect(rows.at(-1)).toMatchObject({
      counts: { status: 0, daemon_log: 0, fsm: 0 },
      droppedRows: { fsm: 7 },
      warnings: ["invalid_timestamp"],
      missingSources: [],
    });
  });

  it("evicts globally oldest complete rows so newer FSM beats older daemon rows", async () => {
    const api = await loadSubject();
    const outputPath = join(tempDir(), "fsm-wins.ndjson.gz");
    await api.buildDiagnosticBundle({
      outputPath,
      header: header(),
      status: null,
      events: [
        event("daemon_log", "old-log-1", 100, "a".repeat(240)),
        event("daemon_log", "old-log-2", 200, "b".repeat(240)),
        event("fsm", "new-fsm", 300, "c".repeat(240)),
      ],
      maxUncompressedBytes: 850,
    });
    const { bytes, rows } = decode(outputPath);
    const encoded = bytes.toString("utf8");
    expect(bytes.byteLength).toBeLessThanOrEqual(850);
    expect(encoded).toContain("new-fsm");
    expect(encoded).not.toContain("old-log-1");
    expect(rows.at(-1)).toMatchObject({ truncated: true });
  });

  it("evicts globally oldest complete rows so newer daemon rows beat older FSM rows", async () => {
    const api = await loadSubject();
    const outputPath = join(tempDir(), "log-wins.ndjson.gz");
    await api.buildDiagnosticBundle({
      outputPath,
      header: header(),
      status: null,
      events: [
        event("fsm", "old-fsm-1", 100, "a".repeat(240)),
        event("fsm", "old-fsm-2", 200, "b".repeat(240)),
        event("daemon_log", "new-log", 300, "c".repeat(240)),
      ],
      maxUncompressedBytes: 850,
    });
    const { bytes, rows } = decode(outputPath);
    const encoded = bytes.toString("utf8");
    expect(bytes.byteLength).toBeLessThanOrEqual(850);
    expect(encoded).toContain("new-log");
    expect(encoded).not.toContain("old-fsm-1");
    expect(rows.at(-1)).toMatchObject({ truncated: true });
  });

  it("keeps complete UTF-8 JSON lines and resolves equal timestamps deterministically", async () => {
    const api = await loadSubject();
    const outputPath = join(tempDir(), "utf8.ndjson.gz");
    await api.buildDiagnosticBundle({
      outputPath,
      header: header(),
      status: null,
      events: [
        event("daemon_log", "log-tie", 100, "错误".repeat(10)),
        event("fsm", "fsm-tie", 100, "诊断".repeat(10)),
        event("fsm", "newest", 200, "完整".repeat(10)),
      ],
      maxUncompressedBytes: 900,
    });
    const { bytes, rows } = decode(outputPath);
    expect(bytes.byteLength).toBeLessThanOrEqual(900);
    expect(() => new TextDecoder("utf-8", { fatal: true }).decode(bytes)).not.toThrow();
    expect(rows.every((row) => typeof row === "object" && row !== null)).toBe(true);
    const times = rows.filter((row) => row.recordType === "fsm" || row.recordType === "daemon_log").map((row) => row.timeMs);
    expect(times).toEqual([...times].sort((a, b) => Number(a) - Number(b)));
    expect(rows.filter((row) => "id" in row).map((row) => [row.recordType, row.id])).toEqual([
      ["daemon_log", "log-tie"],
      ["fsm", "fsm-tie"],
      ["fsm", "newest"],
    ]);
  });

  it("uses strict header projection and excludes hostname, username, paths, env, and credentials", async () => {
    const api = await loadSubject();
    const outputPath = join(tempDir(), "header.ndjson.gz");
    await api.buildDiagnosticBundle({
      outputPath,
      header: header({
        hostname: "HOSTNAME_LEAK",
        username: "USERNAME_LEAK",
        home: "/Users/alice",
        workdir: "/Users/alice/project",
        env: { TOKEN: "ENV_LEAK" },
        machineKey: "cmk_SECRET",
        reconnectToken: "cmt_SECRET",
      }),
      status: null,
      events: [],
    });
    const encoded = decode(outputPath).bytes.toString("utf8");
    expect(encoded).not.toMatch(/HOSTNAME_LEAK|USERNAME_LEAK|\/Users\/alice|ENV_LEAK|cmk_SECRET|cmt_SECRET/);
    expect(Object.keys(decode(outputPath).rows[0]!).sort()).toEqual([
      "agentId",
      "capturedAt",
      "deadlineAt",
      "fromMs",
      "machineId",
      "recordType",
      "reportId",
      "schemaVersion",
    ]);
  });

  it("consumes a lazy AsyncIterable event source", async () => {
    const api = await loadSubject();
    const outputPath = join(tempDir(), "async.ndjson.gz");
    const pulled: string[] = [];
    async function* events(): AsyncGenerator<DiagnosticEventRow> {
      for (const row of [event("daemon_log", "async-log", 100), event("fsm", "async-fsm", 200)]) {
        pulled.push(String(row.id));
        await Promise.resolve();
        yield row;
      }
    }
    const source = events();
    expect(pulled).toEqual([]);
    await api.buildDiagnosticBundle({ outputPath, header: header(), status: null, events: source });
    expect(pulled).toEqual(["async-log", "async-fsm"]);
    expect(decode(outputPath).rows.filter((row) => "id" in row).map((row) => row.id)).toEqual([
      "async-log",
      "async-fsm",
    ]);
  });

  it("produces deterministic gzip bytes and lowercase SHA for identical canonical input", async () => {
    const api = await loadSubject();
    const dir = tempDir();
    const args = {
      header: header(),
      status: { recordType: "status", timeMs: 1500, agentId: "target-agent", status: "idle" },
      events: [event("fsm", "one", 1600), event("daemon_log", "two", 1700)],
    };
    const one = await api.buildDiagnosticBundle({ ...args, outputPath: join(dir, "one.gz") });
    const two = await api.buildDiagnosticBundle({ ...args, outputPath: join(dir, "two.gz") });
    expect(readFileSync(one.path)).toEqual(readFileSync(two.path));
    expect(one.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(two.sha256).toBe(one.sha256);
  });

  it("enforces the production 9 MiB complete-envelope and 10 MiB gzip limits", async () => {
    const api = await loadSubject();
    expect(api.DIAGNOSTIC_NDJSON_MAX_BYTES).toBe(9 * 1024 * 1024);
    expect(api.DIAGNOSTIC_GZIP_MAX_BYTES).toBe(10 * 1024 * 1024);

    const outputPath = join(tempDir(), "max.ndjson.gz");
    const noisy = randomBytes(700_000).toString("base64");
    const events = Array.from({ length: 12 }, (_, index) => event(
      index % 2 === 0 ? "daemon_log" : "fsm",
      `row-${index}`,
      1000 + index,
      noisy,
    ));
    const artifact = await api.buildDiagnosticBundle({ outputPath, header: header(), status: null, events });
    const decoded = decode(outputPath);
    expect(decoded.bytes.byteLength).toBeLessThanOrEqual(api.DIAGNOSTIC_NDJSON_MAX_BYTES);
    expect(artifact.uncompressedBytes).toBe(decoded.bytes.byteLength);
    expect(artifact.sizeBytes).toBeLessThanOrEqual(api.DIAGNOSTIC_GZIP_MAX_BYTES);
    expect(decoded.rows.at(-1)).toMatchObject({ recordType: "bundle_footer", truncated: true });
  });

  it("fails closed and removes the output when an injected compressed limit is exceeded", async () => {
    const api = await loadSubject();
    const outputPath = join(tempDir(), "too-large.ndjson.gz");
    await expect(api.buildDiagnosticBundle({
      outputPath,
      header: header(),
      status: null,
      events: [event("fsm", "noise", 100, randomBytes(4096).toString("base64"))],
      maxCompressedBytes: 64,
    })).rejects.toMatchObject({ code: "bundle_too_large" });
    expect(() => readFileSync(outputPath)).toThrow();
  });
});
