
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

  noteRuntimeEvent(eventKind: string | null, nowMs: number = Date.now()): void {
    this.lastEventAtMs = nowMs;
    this.lastEventKindValue = eventKind ?? null;
    this.staleSinceMs = null;
  }

  noteInternalProgress(observedAtMs: number = Date.now()): void {
    this.lastEventAtMs = observedAtMs;
    this.staleSinceMs = null;
  }

  markStale(nowMs: number = Date.now()): number {
    this.staleSinceMs ??= nowMs;
    return this.staleSinceMs;
  }
}
