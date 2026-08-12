import { createHash } from "node:crypto";
import { createWriteStream, unlinkSync } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import type { BundleArtifact, DiagnosticEventRow } from "./types.js";

export const DIAGNOSTIC_NDJSON_MAX_BYTES = 9 * 1024 * 1024;
export const DIAGNOSTIC_GZIP_MAX_BYTES = 10 * 1024 * 1024;

class BundleTooLargeError extends Error {
  readonly code = "bundle_too_large";
  constructor() { super("diagnostic bundle exceeds its compressed byte limit"); }
}

function line(value: Record<string, unknown>): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function projectHeader(header: Record<string, unknown>): Record<string, unknown> {
  return {
    recordType: header.recordType,
    schemaVersion: header.schemaVersion,
    reportId: header.reportId,
    agentId: header.agentId,
    machineId: header.machineId,
    capturedAt: header.capturedAt,
    fromMs: header.fromMs,
    deadlineAt: header.deadlineAt,
  };
}

async function* asAsync<T>(input: AsyncIterable<T> | Iterable<T>): AsyncGenerator<T> {
  if (Symbol.asyncIterator in input) {
    for await (const value of input as AsyncIterable<T>) yield value;
  } else {
    for (const value of input as Iterable<T>) yield value;
  }
}

function missingSources(warnings: readonly string[]): string[] {
  const missing: string[] = [];
  if (warnings.includes("daemon_log_missing")) missing.push("daemon_log");
  if (warnings.includes("fsm_trace_missing")) missing.push("fsm_trace");
  if (warnings.includes("status_missing")) missing.push("status");
  return missing;
}

const WARNING_CODES = new Set([
  "daemon_log_missing",
  "fsm_trace_missing",
  "status_missing",
  "source_unavailable",
  "malformed_json",
  "line_too_long",
  "incomplete_tail",
  "invalid_timestamp",
]);

function fixedFooter(args: {
  status: Record<string, unknown> | null;
  earliestAt: number | null;
  latestAt: number | null;
  counts: { status: number; daemon_log: number; fsm: number };
  warnings: readonly string[];
  missing: readonly string[];
  droppedRows: Readonly<Record<string, number>>;
  truncated: boolean;
  prefixBytes: number;
}): { value: Record<string, unknown>; bytes: Buffer } {
  let uncompressedBytes = 0;
  let value: Record<string, unknown>;
  let bytes: Buffer;
  do {
    value = {
      recordType: "bundle_footer",
      earliestAt: args.earliestAt,
      latestAt: args.latestAt,
      counts: args.counts,
      missingSources: [...args.missing],
      warnings: [...args.warnings],
      droppedRows: { ...args.droppedRows },
      truncated: args.truncated,
      uncompressedBytes,
    };
    bytes = line(value);
    const next = args.prefixBytes + bytes.byteLength;
    if (next === uncompressedBytes) break;
    uncompressedBytes = next;
  } while (true);
  return { value: value!, bytes: bytes! };
}

export async function buildDiagnosticBundle(args: {
  outputPath: string;
  header: Record<string, unknown>;
  status: Record<string, unknown> | null;
  events: AsyncIterable<DiagnosticEventRow> | Iterable<DiagnosticEventRow>;
  sourceWarnings?: readonly string[];
  sourceDroppedRows?: Readonly<Record<string, number>>;
  maxUncompressedBytes?: number;
  maxCompressedBytes?: number;
}): Promise<BundleArtifact> {
  const maxUncompressed = args.maxUncompressedBytes ?? DIAGNOSTIC_NDJSON_MAX_BYTES;
  const maxCompressed = args.maxCompressedBytes ?? DIAGNOSTIC_GZIP_MAX_BYTES;
  const headerBytes = line(projectHeader(args.header));
  const statusBytes = args.status ? line(args.status) : null;
  const warnings = [...new Set((args.sourceWarnings ?? []).filter((warning) => WARNING_CODES.has(warning)))];
  const missing = missingSources(warnings);
  const droppedRows: Record<string, number> = {};
  for (const key of ["daemon_log", "fsm", "status"] as const) {
    const value = args.sourceDroppedRows?.[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) droppedRows[key] = value;
  }
  const retained: Array<{ row: DiagnosticEventRow; bytes: Buffer }> = [];
  let head = 0;
  let retainedBytes = 0;
  let truncated = false;
  const counts = { status: args.status ? 1 : 0, daemon_log: 0, fsm: 0 };
  const statusTime = typeof args.status?.timeMs === "number" ? args.status.timeMs : null;

  const envelope = (): { footer: Buffer; total: number } => {
    const firstEvent = retained[head]?.row.timeMs ?? null;
    const lastEvent = retained.at(-1)?.row.timeMs ?? null;
    const earliestAt = statusTime === null ? firstEvent : firstEvent === null ? statusTime : Math.min(statusTime, firstEvent);
    const latestAt = statusTime === null ? lastEvent : lastEvent === null ? statusTime : Math.max(statusTime, lastEvent);
    const footer = fixedFooter({
      status: args.status,
      earliestAt,
      latestAt,
      counts,
      warnings,
      missing,
      droppedRows,
      truncated,
      prefixBytes: headerBytes.byteLength + (statusBytes?.byteLength ?? 0) + retainedBytes,
    }).bytes;
    return { footer, total: headerBytes.byteLength + (statusBytes?.byteLength ?? 0) + retainedBytes + footer.byteLength };
  };

  for await (const row of asAsync(args.events)) {
    if (row.recordType !== "daemon_log" && row.recordType !== "fsm") continue;
    if (!Number.isSafeInteger(row.timeMs) || row.timeMs < 0) {
      droppedRows[row.recordType] = (droppedRows[row.recordType] ?? 0) + 1;
      if (!warnings.includes("invalid_timestamp")) warnings.push("invalid_timestamp");
      continue;
    }
    const serialized = line(row);
    retained.push({ row, bytes: serialized });
    retainedBytes += serialized.byteLength;
    counts[row.recordType] += 1;
    while (envelope().total > maxUncompressed && head < retained.length) {
      const removed = retained[head]!;
      delete retained[head];
      head += 1;
      retainedBytes -= removed.bytes.byteLength;
      counts[removed.row.recordType] -= 1;
      droppedRows[removed.row.recordType] = (droppedRows[removed.row.recordType] ?? 0) + 1;
      truncated = true;
    }
    if (head > 4_096 && head * 2 > retained.length) {
      retained.splice(0, head);
      head = 0;
    }
  }

  const { footer, total } = envelope();
  if (total > maxUncompressed) throw new BundleTooLargeError();
  const hash = createHash("sha256");
  let compressedBytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      compressedBytes += chunk.byteLength;
      if (compressedBytes > maxCompressed) { callback(new BundleTooLargeError()); return; }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  let created = false;
  const destination = createWriteStream(args.outputPath, { flags: "wx", mode: 0o600 });
  destination.once("open", () => { created = true; });
  try {
    await pipeline(
      Readable.from([
        headerBytes,
        ...(statusBytes ? [statusBytes] : []),
        ...retained.slice(head).map((entry) => entry.bytes),
        footer,
      ]),
      createGzip({ level: 9 }),
      meter,
      destination,
    );
  } catch (error) {
    if (created) { try { unlinkSync(args.outputPath); } catch { /* best effort */ } }
    throw error;
  }
  return {
    path: args.outputPath,
    sizeBytes: compressedBytes,
    sha256: hash.digest("hex"),
    uncompressedBytes: total,
  };
}
