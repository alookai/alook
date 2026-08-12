import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import type { RotatingFileSink } from "../util/rotatingFileSink.js";
import type {
  SnapshotReadResult,
  SnapshotRow,
  SnapshotSourceName,
  SnapshotWarningCode,
} from "./types.js";

function pushWarning(warnings: SnapshotWarningCode[], warning: SnapshotWarningCode): void {
  warnings.push(warning);
}

function readPinnedBytes(fd: number, size: number): Buffer {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const read = readSync(fd, bytes, offset, size - offset, offset);
    if (read === 0) break;
    offset += read;
  }
  return offset === size ? bytes : bytes.subarray(0, offset);
}

export async function readSnapshotJsonLines(args: {
  source: Pick<RotatingFileSink, "openSnapshot">;
  sourceName: SnapshotSourceName;
  fromMs: number;
  maxLineBytes: number;
  timestampOf: (value: Record<string, unknown>) => number | null;
}): Promise<SnapshotReadResult> {
  const stream = openSnapshotJsonLineStream(args);
  const rows: SnapshotRow[] = [];
  for await (const row of stream.rows) rows.push(row);
  return { rows, warnings: stream.warnings, droppedRows: stream.stats.droppedRows };
}

export function openSnapshotJsonLineStream(args: {
  source: Pick<RotatingFileSink, "openSnapshot">;
  sourceName: SnapshotSourceName;
  fromMs: number;
  maxLineBytes: number;
  timestampOf: (value: Record<string, unknown>) => number | null;
}): { rows: AsyncIterable<SnapshotRow>; warnings: SnapshotWarningCode[]; stats: { droppedRows: number }; close(): void } {
  let snapshot: ReturnType<RotatingFileSink["openSnapshot"]>;
  const warnings: SnapshotWarningCode[] = [];
  const stats = { droppedRows: 0 };
  try {
    snapshot = args.source.openSnapshot();
  } catch {
    warnings.push("source_unavailable");
    return { rows: { async *[Symbol.asyncIterator]() { /* empty */ } }, warnings, stats, close: () => {} };
  }
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    try { snapshot.close(); } catch { /* best effort */ }
  };
  if (snapshot.files.length === 0) {
    warnings.push("source_unavailable");
  }
  const rows = (async function* (): AsyncGenerator<SnapshotRow> {
    let ordinal = 0;
    const acceptLine = (line: Buffer): SnapshotRow | null => {
      let value: unknown;
      try { value = JSON.parse(line.toString("utf8")); } catch {
        pushWarning(warnings, "malformed_json"); stats.droppedRows += 1; ordinal += 1; return null;
      }
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        pushWarning(warnings, "malformed_json"); stats.droppedRows += 1; ordinal += 1; return null;
      }
      let timeMs: number | null = null;
      try { timeMs = args.timestampOf(value as Record<string, unknown>); } catch {
        pushWarning(warnings, "invalid_timestamp");
      }
      if (timeMs === null || !Number.isSafeInteger(timeMs) || timeMs < args.fromMs) {
        if (timeMs !== null && (!Number.isSafeInteger(timeMs) || timeMs < 0)) pushWarning(warnings, "invalid_timestamp");
        stats.droppedRows += 1; ordinal += 1; return null;
      }
      const row = { source: args.sourceName, timeMs, ordinal, value: value as Record<string, unknown> };
      ordinal += 1;
      return row;
    };
    try {
      for (const file of snapshot.files) {
        let position = 0;
        let parts: Buffer[] = [];
        let lineBytes = 0;
        let oversize = false;
        try {
          while (position < file.size) {
            const chunk = Buffer.alloc(Math.min(64 * 1024, file.size - position));
            const count = readSync(file.fd, chunk, 0, chunk.length, position);
            if (count === 0) break;
            position += count;
            let start = 0;
            for (let index = 0; index < count; index += 1) {
              if (chunk[index] !== 0x0a) continue;
              const segment = chunk.subarray(start, index);
              if (!oversize && lineBytes + segment.length <= args.maxLineBytes) {
                parts.push(segment);
                lineBytes += segment.length;
              } else {
                oversize = true;
              }
              if (oversize) {
                pushWarning(warnings, "line_too_long"); stats.droppedRows += 1; ordinal += 1;
              } else {
                const row = acceptLine(Buffer.concat(parts, lineBytes));
                if (row) yield row;
              }
              parts = [];
              lineBytes = 0;
              oversize = false;
              start = index + 1;
            }
            const remainder = chunk.subarray(start, count);
            if (!oversize && lineBytes + remainder.length <= args.maxLineBytes) {
              parts.push(remainder);
              lineBytes += remainder.length;
            } else if (remainder.length > 0) {
              oversize = true;
              parts = [];
              lineBytes = 0;
            }
          }
          if (lineBytes > 0 || oversize) {
            pushWarning(warnings, "incomplete_tail"); stats.droppedRows += 1; ordinal += 1;
          }
        } catch {
          pushWarning(warnings, "source_unavailable");
        }
      }
    } finally {
      close();
    }
  })();
  return { rows, warnings, stats, close };
}

const SOURCE_ORDER: Record<SnapshotSourceName, number> = { daemon_log: 0, fsm_trace: 1 };

export function mergeChronologicalSnapshotRows(inputs: readonly SnapshotRow[][]): SnapshotRow[] {
  return inputs.flat().sort((a, b) =>
    a.timeMs - b.timeMs || SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source] || a.ordinal - b.ordinal,
  );
}

export async function* mergeChronologicalSnapshotStreams(
  inputs: readonly AsyncIterable<SnapshotRow>[],
): AsyncGenerator<SnapshotRow> {
  const iterators = inputs.map((input) => input[Symbol.asyncIterator]());
  const heads = await Promise.all(iterators.map((iterator) => iterator.next()));
  try {
    while (true) {
      let selected = -1;
      for (let index = 0; index < heads.length; index += 1) {
        const candidate = heads[index];
        if (!candidate || candidate.done) continue;
        if (selected < 0) { selected = index; continue; }
        const current = heads[selected]!;
        if (current.done) { selected = index; continue; }
        const a = candidate.value;
        const b = current.value;
        if (a.timeMs < b.timeMs
          || (a.timeMs === b.timeMs && SOURCE_ORDER[a.source] < SOURCE_ORDER[b.source])
          || (a.timeMs === b.timeMs && a.source === b.source && a.ordinal < b.ordinal)) selected = index;
      }
      if (selected < 0) break;
      const head = heads[selected]!;
      if (head.done) break;
      yield head.value;
      heads[selected] = await iterators[selected]!.next();
    }
  } finally {
    await Promise.all(iterators.map(async (iterator) => { try { await iterator.return?.(); } catch { /* best effort */ } }));
  }
}

export async function readPinnedJsonFile(args: {
  path: string;
  maxBytes: number;
}): Promise<{ value: unknown | null; warnings: SnapshotWarningCode[] }> {
  let fd: number | null = null;
  try {
    const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
    fd = openSync(args.path, constants.O_RDONLY | noFollow);
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { value: null, warnings: ["source_unavailable"] };
    if (stat.size > args.maxBytes) return { value: null, warnings: ["line_too_long"] };
    const bytes = readPinnedBytes(fd, stat.size);
    try {
      return { value: JSON.parse(bytes.toString("utf8")), warnings: [] };
    } catch {
      return { value: null, warnings: ["malformed_json"] };
    }
  } catch {
    return { value: null, warnings: ["source_unavailable"] };
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
}
