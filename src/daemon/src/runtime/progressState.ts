/**
 * RuntimeProgressState — liveness tracking.
 *
 * Records the timestamp/kind of the last observed runtime activity so the
 * orchestrator can tell "still working" from "stalled". Any real event or
 * internal streaming progress clears the stale flag; `markStale` is a one-shot
 * latch (set once, idempotent) used to trigger stalled-recovery termination.
 */
export class RuntimeProgressState {
  private lastEventAtMs: number;
  private lastEventKindValue: string | null = null;
  private staleSinceMs: number | null = null;

  constructor(nowMs: number = Date.now()) {
    this.lastEventAtMs = nowMs;
  }

  get lastEventAt(): number {
    return this.lastEventAtMs;
  }
  get lastEventKind(): string | null {
    return this.lastEventKindValue;
  }
  get staleSince(): number | null {
    return this.staleSinceMs;
  }
  get isStale(): boolean {
    return this.staleSinceMs !== null;
  }

  ageMs(nowMs: number = Date.now()): number {
    return nowMs - this.lastEventAtMs;
  }

  /** A normalized runtime event arrived (tool call, model text, …). */
  noteRuntimeEvent(eventKind: string | null, nowMs: number = Date.now()): void {
    this.lastEventAtMs = nowMs;
    this.lastEventKindValue = eventKind ?? null;
    this.staleSinceMs = null;
  }

  /** Sub-event streaming progress; advances the clock but not the kind. */
  noteInternalProgress(observedAtMs: number = Date.now()): void {
    this.lastEventAtMs = observedAtMs;
    this.staleSinceMs = null;
  }

  /** Latch staleness (idempotent). Returns the stale-since timestamp. */
  markStale(nowMs: number = Date.now()): number {
    this.staleSinceMs ??= nowMs;
    return this.staleSinceMs;
  }
}
