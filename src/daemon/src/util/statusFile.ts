/**
 * Atomic status-file writer for the `daemon status` snapshot (batch E2).
 *
 * The FSM daemon has NO IPC — `daemon stop`/`list`/`status` are separate CLI
 * processes, and `manager.snapshot()` lives only inside the running daemon. So
 * to answer "what is each agent's FSM state right now" out-of-band, the running
 * daemon periodically writes a slim projection to its per-key status file
 * (`daemons/<keyHash>/status.json` since batch C0 — was a single global
 * `<baseDir>/status.json`, which multiple daemons clobbered) and the
 * `daemon status` CLI reads that file (Cecilia's ruling (a): snapshot-file,
 * not a control listener — zero new network/attack surface, crash-safe: if the
 * daemon dies the last frame is still readable). See plans/daemon-fsm-desync.md.
 *
 * ATOMIC: write to `<path>.tmp` then `rename` over `<path>`, so a concurrent
 * `daemon status` read never sees a half-written file (rename is atomic on the
 * same filesystem). Best-effort: a status write must NEVER break the daemon, so
 * failures are swallowed — a missing/stale status file is a tolerable "unknown",
 * far better than a crash.
 */
import { writeFileSync, renameSync } from "node:fs";

/** Shape persisted to status.json. Metadata only — no message content, no PII. */
export interface DaemonStatusSnapshot {
  /** ms epoch when this snapshot was written — the reader flags its age. */
  writtenAt: number;
  /**
   * Authoritative machine-level counts for `daemon list`.
   *
   * `total` is null until the daemon has loaded its machine-scoped bot roster;
   * reporting zero before that point would turn an unknown into a lie.
   * `running` comes from the process manager's owned physical sessions.
   *
   * Optional for compatibility with snapshots written by older daemons.
   */
  agentSummary?: {
    total: number | null;
    running: number;
  };
  agents: Array<{
    agentId: string;
    status: string;
    derivedActivity: string;
    turnActive: boolean;
    inbox: number;
    sinceProgressMs: number;
    stoppingSince: number | null;
  }>;
}

/** Write the snapshot atomically. Best-effort — never throws. */
export function writeStatusFile(path: string, snapshot: DaemonStatusSnapshot): void {
  try {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(snapshot));
    renameSync(tmp, path);
  } catch {
    /* never let status writing break the daemon */
  }
}
