/**
 * RuntimeTurnState — the fine-grained steering gate.
 *
 * For `busyDeliveryMode: "gated"` runtimes (Claude), the daemon may NOT inject a
 * busy message at an arbitrary instant: a raw stdin write mid-stream can collide
 * with an active signed thinking block. This tiny state machine tracks whether
 * we're currently at a safe point.
 *
 *   turn starts        → gate OPEN  (canSteerBusy = true)
 *   tool boundary hit  → gate SHUT  (hold writes)
 *   progress observed  → gate OPEN
 *   turn completes     → idle, gate OPEN
 *
 * `canSteerBusy` is the single question the delivery path asks before writing.
 */
export class RuntimeTurnState {
  private currentTurnId: string | null = null;
  private steeringGateActive = false;

  /** Safe to write a busy (steering) message right now? */
  get canSteerBusy(): boolean {
    return Boolean(this.currentTurnId && !this.steeringGateActive);
  }

  get activeTurnId(): string | null {
    return this.currentTurnId;
  }

  /** A new turn began: adopt its id and open the gate. */
  markTurnStarted(turnId?: string | null): void {
    if (turnId !== undefined && turnId !== null) {
      this.currentTurnId = turnId;
    }
    this.steeringGateActive = false;
  }

  /** Learn the turn id without touching the gate. */
  adoptTurnId(turnId: string | null): void {
    this.currentTurnId = turnId;
  }

  /** Entered a tool boundary — close the gate (may be emitting a thinking block). */
  markToolBoundary(): void {
    this.steeringGateActive = true;
  }

  /** Fresh progress (a delta) — reopen the gate. */
  markProgress(): void {
    this.steeringGateActive = false;
  }

  /** Turn finished — go idle, gate open. */
  markTurnCompleted(): void {
    this.currentTurnId = null;
    this.steeringGateActive = false;
  }

  reset(): void {
    this.currentTurnId = null;
    this.steeringGateActive = false;
  }
}
