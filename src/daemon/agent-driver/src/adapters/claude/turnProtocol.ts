import { randomUUID } from "node:crypto";

interface DeliveredInput {
  acknowledged: boolean;
  followOn: boolean;
}

/**
 * Tracks the provider segments that together implement one logical Claude turn.
 *
 * Claude may emit a result before every stdin steering frame has been replayed
 * to stdout. Those not-yet-acknowledged frames become a follow-on provider
 * segment in the same persistent process. Only the result for the latest
 * acknowledged follow-on UUID is the logical terminal.
 */
export class ClaudeTurnProtocol {
  private rootUuid: string | null = null;
  private segmentOwnerUuid: string | null = null;
  private readonly delivered = new Map<string, DeliveredInput>();
  private awaitingFollowOn = false;
  private finalized = false;

  beginTurn(): string {
    const uuid = randomUUID();
    this.rootUuid = uuid;
    this.segmentOwnerUuid = uuid;
    this.delivered.clear();
    this.delivered.set(uuid, { acknowledged: false, followOn: false });
    this.awaitingFollowOn = false;
    this.finalized = false;
    return this.receipt(uuid);
  }

  rootInputUuid(): string {
    if (!this.rootUuid) this.beginTurn();
    return this.rootUuid!;
  }

  steeringInputUuid(): string {
    const uuid = randomUUID();
    this.delivered.set(uuid, { acknowledged: false, followOn: this.awaitingFollowOn });
    return uuid;
  }

  acknowledge(uuid: string): void {
    const input = this.delivered.get(uuid);
    if (!input || this.finalized) return;
    input.acknowledged = true;
    if (input.followOn) this.segmentOwnerUuid = uuid;
  }

  acceptsTurnWork(): boolean {
    if (!this.rootUuid || this.finalized) return false;
    return this.delivered.get(this.rootUuid)?.acknowledged === true;
  }

  /** Returns the logical root receipt only when this is the final provider segment. */
  claimResult(userMessageUuid: string): string | null {
    if (this.finalized || !this.rootUuid || userMessageUuid !== this.segmentOwnerUuid) return null;
    const owner = this.delivered.get(userMessageUuid);
    if (owner) owner.acknowledged = true;
    const unacknowledged = [...this.delivered.entries()]
      .filter(([, input]) => !input.acknowledged);
    if (unacknowledged.length > 0) {
      this.awaitingFollowOn = true;
      for (const [, input] of unacknowledged) input.followOn = true;
      return null;
    }
    this.finalized = true;
    return this.receipt(this.rootUuid);
  }

  private receipt(uuid: string): string {
    return `claude:${uuid}`;
  }
}
