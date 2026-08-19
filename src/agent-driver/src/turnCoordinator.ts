import type {
  AgentDriverDeliveryResult,
  AgentDriverDescriptor,
  AgentDriverEvent,
  AgentDriverPrompt,
  AgentDriverReceipt,
  AgentDriverRuntimeSessionEvent,
  AgentDriverRuntimeTerminalEvent,
  AgentDriverRuntimeTurnEvent,
  AgentDriverTurnResult,
} from "./contracts.js";
import { AgentDriverContractError } from "./contracts.js";

export interface AgentDriverTurnOperation {
  readonly turnId: string;
  readonly prompts: readonly AgentDriverPrompt[];
  emit(event: AgentDriverRuntimeTurnEvent): void;
}

export interface AgentDriverTurnCoordinatorOptions {
  readonly descriptor: AgentDriverDescriptor;
  readonly sessionId: () => string | null;
  readonly publish: (event: AgentDriverEvent) => void;
  /** Resolve only after the runtime accepts the fresh prompt; terminal completion is emitted separately. */
  readonly startTurn: (operation: AgentDriverTurnOperation) => void | Promise<void>;
  /** Resolve only after the runtime accepts the steer; terminal completion is emitted separately. */
  readonly steerTurn?: (operation: AgentDriverTurnOperation) => void | Promise<void>;
  readonly settleTurn?: (settlement: AgentDriverTurnSettlement) => void | Promise<void>;
  /** Called synchronously when a fatal lifecycle barrier fails. */
  readonly onFatal?: (error: unknown) => void;
  readonly createTurnId?: () => string;
}

export interface AgentDriverTurnSettlement {
  readonly turnId: string;
  readonly terminal: AgentDriverRuntimeTerminalEvent;
}

interface DeliveryEntry {
  readonly prompt: AgentDriverPrompt;
  readonly signature: string;
  readonly promise: Promise<AgentDriverReceipt>;
  resolve(receipt: AgentDriverReceipt): void;
  receipt?: AgentDriverReceipt;
  boundTurnId?: string;
  terminal: boolean;
}

interface ActiveTurn {
  readonly turnId: string;
  readonly deliveries: DeliveryEntry[];
}

interface TurnEventSink {
  emit(event: AgentDriverRuntimeTurnEvent): void;
  activate(): void;
  discard(): void;
}

function deliverySignature(prompt: AgentDriverPrompt): string {
  return JSON.stringify([prompt.text, prompt.mode, prompt.intent, prompt.execution]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class AgentDriverTurnCoordinator {
  private readonly deliveries = new Map<string, DeliveryEntry>();
  private readonly terminalTurnIds = new Set<string>();
  private readonly boundDeliveryIds = new Set<string>();
  private readonly pendingGated: DeliveryEntry[] = [];
  private readonly nextQueue: DeliveryEntry[] = [];
  private active: ActiveTurn | null = null;
  private provisionalEntries: DeliveryEntry[] = [];
  private provisionalSink: TurnEventSink | null = null;
  private operationPending = false;
  private turnSettlementPending = false;
  private closed = false;
  private turnOrdinal = 0;

  constructor(private readonly options: AgentDriverTurnCoordinatorOptions) {}

  deliver(prompt: AgentDriverPrompt): Promise<AgentDriverReceipt> {
    const signature = deliverySignature(prompt);
    const existing = this.deliveries.get(prompt.deliveryId);
    if (existing) {
      if (existing.signature === signature) return existing.promise;
      return Promise.resolve({
        accepted: false,
        deliveryId: prompt.deliveryId,
        reason: "duplicate_delivery_conflict",
        message: `Delivery ${prompt.deliveryId} was replayed with different content or metadata`,
      });
    }

    let resolveReceipt: (receipt: AgentDriverReceipt) => void = () => undefined;
    const entry: DeliveryEntry = {
      prompt,
      signature,
      promise: new Promise((resolve) => {
        resolveReceipt = resolve;
      }),
      resolve: (receipt) => {
        if (entry.receipt) return;
        entry.receipt = receipt;
        resolveReceipt(receipt);
      },
      terminal: false,
    };
    this.deliveries.set(prompt.deliveryId, entry);

    if (this.closed) {
      entry.resolve({ accepted: false, deliveryId: prompt.deliveryId, reason: "closed" });
      return entry.promise;
    }

    this.accept(entry);
    return entry.promise;
  }

  flushGated(): Promise<void> {
    if (this.closed || !this.active || this.pendingGated.length === 0 || this.operationPending) {
      return Promise.resolve();
    }
    const entries = this.pendingGated.splice(0);
    return this.bindSteer(entries, this.active);
  }

  publishSessionEvent(event: AgentDriverRuntimeSessionEvent): void {
    if (this.closed) return;
    this.options.publish(event);
  }

  private handleRuntimeEventForTurn(expectedTurnId: string, event: AgentDriverRuntimeTurnEvent): void {
    if (this.closed) return;
    const active = this.active;
    if (!active || active.turnId !== expectedTurnId || this.terminalTurnIds.has(expectedTurnId)) return;
    if (event.kind === "turn_terminal") {
      this.finishActiveTurn(event);
      return;
    }
    this.options.publish({ ...event, turnId: expectedTurnId });
  }

  abortAll(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.provisionalSink?.discard();

    const active = this.active;
    if (active && !this.terminalTurnIds.has(active.turnId)) {
      this.finishTurn(active, {
        kind: "turn_terminal",
        status: "aborted",
        reason,
        sessionId: this.options.sessionId() ?? undefined,
      });
    }
    const unbound = [
      ...this.provisionalEntries,
      ...this.pendingGated,
      ...this.nextQueue,
    ];
    this.provisionalEntries = [];
    this.pendingGated.splice(0);
    this.nextQueue.splice(0);
    for (const entry of unbound) this.abortUnbound(entry, reason);
  }

  get activeTurnId(): string | null {
    return this.active?.turnId ?? null;
  }

  get pendingCounts(): Readonly<{ gated: number; next: number; provisional: number }> {
    return {
      gated: this.pendingGated.length,
      next: this.nextQueue.length,
      provisional: this.provisionalEntries.length,
    };
  }

  private accept(entry: DeliveryEntry): void {
    const lifecycle = this.options.descriptor.lifecycle;
    if (this.operationPending || this.turnSettlementPending) {
      this.queueNext(entry);
      return;
    }
    if (!this.active) {
      if (
        lifecycle.kind === "per_turn"
        && lifecycle.start === "defer_until_concrete"
        && entry.prompt.execution === "bookkeeping"
      ) {
        this.queueNext(entry, "deferred_bookkeeping");
        return;
      }
      const batch = lifecycle.kind === "per_turn" && lifecycle.start === "defer_until_concrete"
        ? [...this.nextQueue.splice(0), entry]
        : [entry];
      void this.startFreshTurn(batch);
      return;
    }

    if (lifecycle.kind === "per_turn") {
      this.queueNext(entry);
      return;
    }
    if (lifecycle.busyDelivery === "gated_steer_coalesce") {
      this.pendingGated.push(entry);
      entry.resolve({ accepted: true, deliveryId: entry.prompt.deliveryId, delivery: "pending_gated" });
      return;
    }
    void this.bindSteer([entry], this.active);
  }

  private queueNext(
    entry: DeliveryEntry,
    delivery: "queued_next_turn" | "deferred_bookkeeping" = "queued_next_turn",
  ): void {
    this.nextQueue.push(entry);
    entry.resolve({ accepted: true, deliveryId: entry.prompt.deliveryId, delivery });
  }

  private async startFreshTurn(entries: DeliveryEntry[]): Promise<void> {
    if (entries.length === 0 || this.closed) return;
    this.operationPending = true;
    this.provisionalEntries = entries;
    const turnId = this.options.createTurnId?.() ?? `turn-${++this.turnOrdinal}`;
    const sink = this.createTurnEventSink(turnId);
    this.provisionalSink = sink;
    const operation: AgentDriverTurnOperation = {
      turnId,
      prompts: entries.map((entry) => entry.prompt),
      emit: (event) => sink.emit(event),
    };
    try {
      await this.options.startTurn(operation);
      if (this.closed) {
        for (const entry of entries) this.abortUnbound(entry, "closed");
        return;
      }
      const turn: ActiveTurn = { turnId, deliveries: [] };
      this.active = turn;
      this.options.publish({
        kind: "turn_started",
        turnId,
        deliveryIds: entries.map((entry) => entry.prompt.deliveryId),
        sessionId: this.options.sessionId() ?? undefined,
      });
      for (const entry of entries) {
        this.bindEntry(entry, turn);
        entry.resolve({
          accepted: true,
          deliveryId: entry.prompt.deliveryId,
          delivery: "prompt",
          turnId,
        });
      }
      sink.activate();
    } catch (error) {
      sink.discard();
      for (const entry of entries) this.failUnbound(entry, error);
    } finally {
      this.provisionalEntries = [];
      if (this.provisionalSink === sink) this.provisionalSink = null;
      this.operationPending = false;
      this.promote();
    }
  }

  private async bindSteer(entries: DeliveryEntry[], expectedTurn: ActiveTurn): Promise<void> {
    if (entries.length === 0 || this.closed) return;
    this.operationPending = true;
    this.provisionalEntries = entries;
    const sink = this.createTurnEventSink(expectedTurn.turnId);
    this.provisionalSink = sink;
    try {
      if (!this.options.steerTurn) throw new Error("Driver does not implement busy steering");
      await this.options.steerTurn({
        turnId: expectedTurn.turnId,
        prompts: entries.map((entry) => entry.prompt),
        emit: (event) => sink.emit(event),
      });
      if (this.closed) {
        for (const entry of entries) this.abortUnbound(entry, "closed");
        return;
      }
      if (this.active !== expectedTurn || this.terminalTurnIds.has(expectedTurn.turnId)) {
        for (const entry of entries) this.failUnbound(entry, new Error("Turn ended before steer was accepted"));
        return;
      }
      for (const entry of entries) {
        this.bindEntry(entry, expectedTurn);
        entry.resolve({
          accepted: true,
          deliveryId: entry.prompt.deliveryId,
          delivery: "steer",
          turnId: expectedTurn.turnId,
        });
      }
      sink.activate();
    } catch (error) {
      sink.discard();
      for (const entry of entries) this.failUnbound(entry, error);
    } finally {
      this.provisionalEntries = [];
      if (this.provisionalSink === sink) this.provisionalSink = null;
      this.operationPending = false;
      this.promote();
    }
  }

  private bindEntry(entry: DeliveryEntry, turn: ActiveTurn): void {
    if (this.boundDeliveryIds.has(entry.prompt.deliveryId)) return;
    this.boundDeliveryIds.add(entry.prompt.deliveryId);
    entry.boundTurnId = turn.turnId;
    turn.deliveries.push(entry);
    this.options.publish({ kind: "delivery_bound", deliveryId: entry.prompt.deliveryId, turnId: turn.turnId });
  }

  private finishActiveTurn(event: AgentDriverRuntimeTerminalEvent): void {
    const turn = this.active;
    if (!turn) return;
    const operationWasPending = this.operationPending;
    this.operationPending = true;
    this.active = null;
    if (this.pendingGated.length > 0) this.nextQueue.push(...this.pendingGated.splice(0));
    this.finishTurn(turn, event);
    this.operationPending = operationWasPending;
    const lifecycle = this.options.descriptor.lifecycle;
    if (lifecycle.kind === "per_turn" && this.options.settleTurn) {
      this.beginTurnSettlement(turn.turnId, event);
    } else if (!operationWasPending) {
      this.promote();
    }
  }

  private finishTurn(
    turn: ActiveTurn,
    result: AgentDriverRuntimeTerminalEvent,
  ): void {
    if (this.terminalTurnIds.has(turn.turnId)) return;
    this.terminalTurnIds.add(turn.turnId);
    const deliveryIds = turn.deliveries.map((entry) => entry.prompt.deliveryId);
    for (const entry of turn.deliveries) {
      if (entry.terminal) continue;
      entry.terminal = true;
      const deliveryResult: AgentDriverDeliveryResult = result.status === "clean"
        ? { status: "clean", deliveryId: entry.prompt.deliveryId, turnId: turn.turnId, sessionId: result.sessionId }
        : result.status === "error"
          ? {
              status: "error",
              deliveryId: entry.prompt.deliveryId,
              turnId: turn.turnId,
              sessionId: result.sessionId,
              message: result.message,
              code: result.code,
              retryable: result.retryable,
            }
          : {
              status: "aborted",
              deliveryId: entry.prompt.deliveryId,
              turnId: turn.turnId,
              sessionId: result.sessionId,
              reason: result.reason,
            };
      this.options.publish({ kind: "delivery_result", result: deliveryResult });
    }
    const turnResult: AgentDriverTurnResult = result.status === "clean"
      ? { status: "clean", turnId: turn.turnId, deliveryIds, sessionId: result.sessionId }
      : result.status === "error"
        ? {
            status: "error",
            turnId: turn.turnId,
            deliveryIds,
            sessionId: result.sessionId,
            message: result.message,
            code: result.code,
            retryable: result.retryable,
          }
        : { status: "aborted", turnId: turn.turnId, deliveryIds, sessionId: result.sessionId, reason: result.reason };
    this.options.publish({ kind: "turn_result", result: turnResult });
  }

  private failUnbound(entry: DeliveryEntry, error: unknown): void {
    if (entry.terminal) return;
    const message = errorMessage(error);
    entry.resolve({
      accepted: false,
      deliveryId: entry.prompt.deliveryId,
      reason: "runtime_error",
      message,
    });
    entry.terminal = true;
    this.options.publish({
      kind: "delivery_result",
      result: { status: "error", deliveryId: entry.prompt.deliveryId, message },
    });
  }

  private abortUnbound(entry: DeliveryEntry, reason: string): void {
    if (entry.terminal || entry.boundTurnId) return;
    entry.resolve({ accepted: false, deliveryId: entry.prompt.deliveryId, reason: "closed" });
    entry.terminal = true;
    this.options.publish({
      kind: "delivery_result",
      result: { status: "aborted", deliveryId: entry.prompt.deliveryId, reason },
    });
  }

  private promote(): void {
    if (this.closed || this.operationPending || this.turnSettlementPending || this.nextQueue.length === 0) return;
    const lifecycle = this.options.descriptor.lifecycle;
    if (this.active) {
      if (lifecycle.kind === "persistent" && lifecycle.busyDelivery === "direct_steer") {
        const entries = this.nextQueue.splice(0);
        void this.bindSteer(entries, this.active);
      } else if (lifecycle.kind === "persistent") {
        this.pendingGated.push(...this.nextQueue.splice(0));
      }
      return;
    }
    if (
      lifecycle.kind === "per_turn"
      && lifecycle.start === "defer_until_concrete"
      && !this.nextQueue.some((entry) => entry.prompt.execution === "concrete")
    ) {
      return;
    }
    const entries = this.nextQueue.splice(0);
    void this.startFreshTurn(entries);
  }

  private createTurnEventSink(expectedTurnId: string): TurnEventSink {
    const buffered: AgentDriverRuntimeTurnEvent[] = [];
    let state: "provisional" | "flushing" | "live" | "discarded" = "provisional";
    return {
      emit: (event) => {
        if (state === "discarded") return;
        if (state === "provisional" || state === "flushing") {
          buffered.push(event);
          return;
        }
        this.handleRuntimeEventForTurn(expectedTurnId, event);
      },
      activate: () => {
        if (state !== "provisional") return;
        state = "flushing";
        while (buffered.length > 0) {
          this.handleRuntimeEventForTurn(expectedTurnId, buffered.shift()!);
        }
        state = "live";
      },
      discard: () => {
        state = "discarded";
        buffered.splice(0);
      },
    };
  }

  private beginTurnSettlement(turnId: string, terminal: AgentDriverRuntimeTerminalEvent): void {
    this.turnSettlementPending = true;
    let settlement: void | Promise<void>;
    try {
      settlement = this.options.settleTurn!({ turnId, terminal });
    } catch (error) {
      this.failTurnSettlement(error);
      return;
    }
    void Promise.resolve(settlement).then(
      () => {
        this.turnSettlementPending = false;
        this.promote();
      },
      (error: unknown) => this.failTurnSettlement(error),
    );
  }

  private failTurnSettlement(error: unknown): void {
    this.turnSettlementPending = false;
    this.closed = true;
    const unbound = [...this.pendingGated.splice(0), ...this.nextQueue.splice(0)];
    for (const entry of unbound) this.failUnbound(entry, error);
    this.options.onFatal?.(error);
  }
}

export interface AgentDriverToolCallStart {
  readonly nativeId?: string;
  readonly protocolIdentity?: string;
  readonly name: string;
  readonly input: unknown;
}

export interface AgentDriverToolCallFinish {
  readonly nativeId?: string;
  readonly protocolIdentity?: string;
  readonly name: string;
  readonly output?: unknown;
  readonly isError?: boolean;
}

/**
 * Turn-scoped correlation helper for runtime normalizers. Native ids always
 * win. A stable synthetic id is allowed only when the protocol supplies an
 * identity that can be mapped across start/result, or when exactly one tool is
 * outstanding; ambiguous completion is rejected instead of guessed by name.
 */
export class AgentDriverToolCallLedger {
  private readonly outstanding = new Map<string, { readonly name: string }>();
  private readonly protocolIds = new Map<string, string>();
  private ordinal = 0;

  constructor(private readonly turnId: string) {}

  start(input: AgentDriverToolCallStart): Extract<AgentDriverRuntimeTurnEvent, { kind: "tool_call" }> {
    const toolCallId = input.nativeId
      ?? (input.protocolIdentity ? this.protocolIds.get(input.protocolIdentity) : undefined)
      ?? `${this.turnId}:tool:${++this.ordinal}`;
    if (input.protocolIdentity) this.protocolIds.set(input.protocolIdentity, toolCallId);
    this.outstanding.set(toolCallId, { name: input.name });
    return { kind: "tool_call", toolCallId, name: input.name, input: input.input };
  }

  finish(input: AgentDriverToolCallFinish): Extract<AgentDriverRuntimeTurnEvent, { kind: "tool_result" }> {
    let toolCallId = input.nativeId
      ?? (input.protocolIdentity ? this.protocolIds.get(input.protocolIdentity) : undefined);
    if (!toolCallId && this.outstanding.size === 1) toolCallId = this.outstanding.keys().next().value;
    const call = toolCallId ? this.outstanding.get(toolCallId) : undefined;
    if (!toolCallId || !call) {
      throw new AgentDriverContractError(
        "invalid_session_contract",
        `Cannot correlate tool result ${input.name} in turn ${this.turnId} without a unique runtime identity`,
      );
    }
    if (input.name !== call.name) {
      throw new AgentDriverContractError(
        "invalid_session_contract",
        `Tool result ${toolCallId} is named ${input.name}, but its call was ${call.name}`,
      );
    }
    this.outstanding.delete(toolCallId);
    return {
      kind: "tool_result",
      toolCallId,
      name: call.name,
      output: input.output,
      isError: input.isError,
    };
  }

  get outstandingIds(): readonly string[] {
    return [...this.outstanding.keys()];
  }

  /** Terminalizes and clears every unfinished tool call exactly once. */
  abortOutstanding(reason: string): readonly Extract<AgentDriverRuntimeTurnEvent, { kind: "tool_result" }>[] {
    const results = [...this.outstanding].map(([toolCallId, call]) => ({
      kind: "tool_result" as const,
      toolCallId,
      name: call.name,
      output: { reason },
      isError: true,
    }));
    this.outstanding.clear();
    return results;
  }
}
