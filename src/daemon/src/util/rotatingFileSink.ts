/**
 * A tiny size-capped, rotating append sink — the bounded backing for the
 * default-on FSM transition trace (plans/daemon-fsm-desync.md batch E1).
 *
 * WHY net-new: the daemon has no rotation utility (recon-confirmed), and the
 * raw `appendFileSync` sink the trace shipped with (createDaemon.ts) is
 * UNBOUNDED — ~15MB/4h, only grows. That's fine for an opt-in deep-dive
 * (`ALOOK_FSM_TRACE`), but the whole point of E1 is to make the trace DEFAULT
 * ON so we're never blind to a wedge again — and a default that silently fills
 * the disk is a bug, not a feature. This sink caps total on-disk bytes.
 *
 * DESIGN — a 2-file ring (active + `.1`):
 *   - append lines to `<path>`;
 *   - when `<path>` would exceed `maxBytes`, rotate: `rename(<path> → <path>.1)`
 *     (overwriting any previous `.1`), then start a fresh empty `<path>`.
 *   - so on-disk total is bounded by ~2×maxBytes, and we always retain at least
 *     the last `maxBytes` of history (usually ~2×) — enough to hold the last
 *     wedge's FSM trail.
 *
 * Everything is best-effort: a sink must NEVER break the daemon, so every fs
 * call is wrapped and failures are swallowed (same contract as the old inline
 * try/catch). Synchronous fs (appendFileSync/statSync/renameSync) mirrors the
 * existing sink — the write is off the FSM hot path (it runs in the
 * onFsmTransition callback, after the reduce), and keeping it sync avoids
 * interleaving/ordering hazards a per-line async write would add.
 */
import {
  appendFileSync,
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";

export interface RotatingFileSnapshot {
  files: Array<{ path: string; fd: number; size: number }>;
  close(): void;
}

export interface RotatingFileSink {
  /** Tightens every existing generation before a caller starts using the sink. */
  secure(): boolean;
  /** Append one already-serialized line (a trailing newline is added). */
  write(line: string): void;
  /** Opens rotated then active synchronously and pins each generation's size. */
  openSnapshot(): RotatingFileSnapshot;
}

export interface RotatingFileSinkOptions {
  /** Enforced before appending to an existing active generation. */
  mode?: number;
  /** Rotate before a write that would make the active generation exceed maxBytes. */
  hardMaxBytes?: boolean;
  /** Best-effort observability for callers that need to surface sink failure. */
  onError?: (info: { operation: "stat" | "rotate" | "append" | "chmod" | "oversize" | "oversize_generation" | "unsafe_generation" | "snapshot"; error: unknown }) => void;
}

/**
 * @param path      active file path; rotated file is `${path}.1`.
 * @param maxBytes  rotate once the active file reaches/exceeds this. Total
 *                  on-disk ≈ 2×maxBytes. Must be > 0; non-positive disables
 *                  rotation (unbounded) — callers that want a cap must pass > 0.
 *                  hardMaxBytes callers must reject a serialized line larger
 *                  than maxBytes before calling write.
 */
export function createRotatingFileSink(
  path: string,
  maxBytes: number,
  opts: RotatingFileSinkOptions = {},
): RotatingFileSink {
  const report = (operation: "stat" | "rotate" | "append" | "chmod" | "oversize" | "oversize_generation" | "unsafe_generation" | "snapshot", error: unknown): void => {
    try {
      opts.onError?.({ operation, error });
    } catch {
      /* a diagnostic callback cannot break the sink */
    }
  };

  const secureGeneration = (filePath: string): boolean => {
    if (!existsSync(filePath)) return true;
    try {
      const stat = lstatSync(filePath);
      if (!stat.isFile()) {
        if (opts.mode === undefined && !opts.hardMaxBytes) return true;
        report("unsafe_generation", new Error("log generation is not a regular file"));
        return false;
      }
      if (opts.mode !== undefined) chmodSync(filePath, opts.mode);
      if (opts.hardMaxBytes && maxBytes > 0 && stat.size > maxBytes) {
        try {
          unlinkSync(filePath);
        } catch (error) {
          report("oversize_generation", error);
          return false;
        }
        report("oversize_generation", new Error(`removed generation larger than ${maxBytes} bytes`));
      }
      return true;
    } catch (error) {
      report("chmod", error);
      return false;
    }
  };

  const rotate = (): boolean => {
    try {
      // Overwrite any prior `.1` — we only keep one generation back.
      renameSync(path, `${path}.1`);
      if (opts.mode !== undefined) chmodSync(`${path}.1`, opts.mode);
      return true;
    } catch (error) {
      report("rotate", error);
      /* rename can fail (path gone, races) — swallow; next write recreates. */
      return false;
    }
  };

  const currentSize = (): number | null => {
    try {
      return existsSync(path) ? statSync(path).size : 0;
    } catch (error) {
      report("stat", error);
      return null;
    }
  };

  const sink: RotatingFileSink = {
    secure(): boolean {
      return secureGeneration(`${path}.1`) && secureGeneration(path);
    },
    write(line: string): void {
      try {
        if (!sink.secure()) return;
        const serialized = line + "\n";
        const serializedBytes = Buffer.byteLength(serialized, "utf8");
        if (opts.hardMaxBytes && maxBytes > 0 && serializedBytes > maxBytes) {
          report("oversize", new Error(`record exceeds ${maxBytes} bytes`));
          return;
        }
        const measuredBytes = currentSize();
        if (measuredBytes === null && opts.hardMaxBytes) return;
        const currentBytes = measuredBytes ?? 0;
        const shouldRotate = maxBytes > 0 && (opts.hardMaxBytes
          ? currentBytes > 0 && currentBytes + serializedBytes > maxBytes
          : currentBytes >= maxBytes);
        if (shouldRotate && !rotate() && opts.hardMaxBytes) return;
        appendFileSync(path, serialized, opts.mode === undefined ? undefined : { mode: opts.mode });
      } catch (error) {
        report("append", error);
        /* never let tracing break the daemon */
      }
    },
    openSnapshot(): RotatingFileSnapshot {
      const files: RotatingFileSnapshot["files"] = [];
      try {
        for (const candidate of [`${path}.1`, path]) {
          if (!existsSync(candidate)) continue;
          if (!secureGeneration(candidate)) continue;
          const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
          const fd = openSync(candidate, constants.O_RDONLY | noFollow);
          try {
            const stat = fstatSync(fd);
            if (!stat.isFile()) throw new Error("snapshot source is not a regular file");
            files.push({ path: candidate, fd, size: stat.size });
          } catch (error) {
            closeSync(fd);
            throw error;
          }
        }
      } catch (error) {
        for (const file of files) {
          try { closeSync(file.fd); } catch { /* best effort */ }
        }
        report("snapshot", error);
        return { files: [], close: () => {} };
      }
      let closed = false;
      return {
        files,
        close(): void {
          if (closed) return;
          closed = true;
          for (const file of files) {
            try { closeSync(file.fd); } catch { /* best effort */ }
          }
        },
      };
    },
  };
  return sink;
}
