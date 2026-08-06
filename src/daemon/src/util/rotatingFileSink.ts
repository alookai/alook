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
import { appendFileSync, chmodSync, statSync, renameSync, existsSync } from "node:fs";

export interface RotatingFileSink {
  /** Append one already-serialized line (a trailing newline is added). */
  write(line: string): void;
}

export interface RotatingFileSinkOptions {
  /** Enforced before appending to an existing active generation. */
  mode?: number;
  /** Rotate before a write that would make the active generation exceed maxBytes. */
  hardMaxBytes?: boolean;
  /** Best-effort observability for callers that need to surface sink failure. */
  onError?: (info: { operation: "stat" | "rotate" | "append" | "chmod"; error: unknown }) => void;
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
  const report = (operation: "stat" | "rotate" | "append" | "chmod", error: unknown): void => {
    try {
      opts.onError?.({ operation, error });
    } catch {
      /* a diagnostic callback cannot break the sink */
    }
  };

  const secureActive = (): boolean => {
    if (opts.mode === undefined || !existsSync(path)) return true;
    try {
      chmodSync(path, opts.mode);
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

  return {
    write(line: string): void {
      try {
        if (!secureActive()) return;
        const serialized = line + "\n";
        const measuredBytes = currentSize();
        if (measuredBytes === null && opts.hardMaxBytes) return;
        const currentBytes = measuredBytes ?? 0;
        const shouldRotate = maxBytes > 0 && (opts.hardMaxBytes
          ? currentBytes > 0 && currentBytes + Buffer.byteLength(serialized, "utf8") > maxBytes
          : currentBytes >= maxBytes);
        if (shouldRotate && !rotate() && opts.hardMaxBytes) return;
        appendFileSync(path, serialized, opts.mode === undefined ? undefined : { mode: opts.mode });
      } catch (error) {
        report("append", error);
        /* never let tracing break the daemon */
      }
    },
  };
}
