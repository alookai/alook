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
import { appendFileSync, statSync, renameSync, existsSync } from "node:fs";

export interface RotatingFileSink {
  /** Append one already-serialized line (a trailing newline is added). */
  write(line: string): void;
}

/**
 * @param path      active file path; rotated file is `${path}.1`.
 * @param maxBytes  rotate once the active file reaches/exceeds this. Total
 *                  on-disk ≈ 2×maxBytes. Must be > 0; non-positive disables
 *                  rotation (unbounded) — callers that want a cap must pass > 0.
 */
export function createRotatingFileSink(path: string, maxBytes: number): RotatingFileSink {
  const rotate = (): void => {
    try {
      // Overwrite any prior `.1` — we only keep one generation back.
      renameSync(path, `${path}.1`);
    } catch {
      /* rename can fail (path gone, races) — swallow; next write recreates. */
    }
  };

  const currentSize = (): number => {
    try {
      return existsSync(path) ? statSync(path).size : 0;
    } catch {
      return 0;
    }
  };

  return {
    write(line: string): void {
      try {
        // Rotate BEFORE the write that would breach the cap, so the active file
        // never grows unbounded between checks. (A single line can still exceed
        // maxBytes; that's fine — it lands in a freshly-rotated active file and
        // the next write rotates again. Bound holds within one line's slack.)
        if (maxBytes > 0 && currentSize() >= maxBytes) rotate();
        appendFileSync(path, line + "\n");
      } catch {
        /* never let tracing break the daemon */
      }
    },
  };
}
