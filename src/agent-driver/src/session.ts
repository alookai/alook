import type {
  AgentDriverDescriptor,
  AgentDriverCleanupResult,
  AgentDriverCloseOptions,
  AgentDriverEvent,
  AgentDriverEventListener,
  AgentDriverPrompt,
  AgentDriverReceipt,
  AgentDriverSession,
  AgentDriverRuntimeSessionEvent,
} from "./contracts.js";
import type { AgentDriverClock } from "./host.js";
import {
  AgentDriverTurnCoordinator,
  type AgentDriverTurnCoordinatorOptions,
} from "./turnCoordinator.js";

export interface AgentDriverSessionControllerOptions {
  readonly clock: AgentDriverClock;
  readonly defaultForceAfterMs: number;
  readonly sessionId: () => string | null;
  readonly deliver: (prompt: AgentDriverPrompt) => Promise<AgentDriverReceipt>;
  readonly cleanup: (options: AgentDriverCloseOptions) => Promise<void>;
  readonly forceCleanup: (reason: "requested" | "deadline") => Promise<void>;
}

export class AgentDriverSessionController implements AgentDriverSession {
  private readonly listeners = new Set<AgentDriverEventListener>();
  private readonly closeSignal: Promise<void>;
  private resolveCloseSignal: () => void = () => undefined;
  private closePromise: Promise<AgentDriverCleanupResult> | null = null;
  private logicallyClosed = false;
  private readonly deliveryRaces = new WeakMap<Promise<AgentDriverReceipt>, Promise<AgentDriverReceipt>>();

  constructor(private readonly options: AgentDriverSessionControllerOptions) {
    if (!Number.isFinite(options.defaultForceAfterMs) || options.defaultForceAfterMs < 0) {
      throw new RangeError("defaultForceAfterMs must be a non-negative finite duration");
    }
    this.closeSignal = new Promise((resolve) => {
      this.resolveCloseSignal = resolve;
    });
  }

  get sessionId(): string | null {
    return this.options.sessionId();
  }

  get closed(): boolean {
    return this.logicallyClosed;
  }

  subscribe(listener: AgentDriverEventListener): () => void {
    if (this.logicallyClosed) return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: AgentDriverEvent): void {
    if (this.logicallyClosed) return;
    for (const listener of this.listeners) listener(event);
  }

  deliver(prompt: AgentDriverPrompt): Promise<AgentDriverReceipt> {
    if (this.logicallyClosed) {
      return Promise.resolve({ accepted: false, deliveryId: prompt.deliveryId, reason: "closed" });
    }
    let delivery: Promise<AgentDriverReceipt>;
    try {
      delivery = this.options.deliver(prompt);
    } catch (error) {
      delivery = Promise.reject(error);
    }
    const existingRace = this.deliveryRaces.get(delivery);
    if (existingRace) return existingRace;
    const raced = Promise.race([
      delivery,
      this.closeSignal.then(() => ({
        accepted: false,
        deliveryId: prompt.deliveryId,
        reason: "closed",
      } as const)),
    ]);
    this.deliveryRaces.set(delivery, raced);
    return raced;
  }

  close(options: AgentDriverCloseOptions = {}): Promise<AgentDriverCleanupResult> {
    if (this.closePromise) return this.closePromise;
    this.logicallyClosed = true;
    this.resolveCloseSignal();
    this.listeners.clear();
    this.closePromise = this.runCleanup(options);
    return this.closePromise;
  }

  private async runCleanup(options: AgentDriverCloseOptions): Promise<AgentDriverCleanupResult> {
    const invalidForceAfterMs = options.forceAfterMs !== undefined
      && (!Number.isFinite(options.forceAfterMs) || options.forceAfterMs < 0);
    const optionFailure = invalidForceAfterMs
      ? "forceAfterMs must be a non-negative finite duration"
      : null;
    if (options.force) {
      const result = await this.force("requested");
      if (!optionFailure) return result;
      return {
        status: "failed",
        forced: true,
        message: result.status === "failed"
          ? `${optionFailure}; forced cleanup failed: ${result.message}`
          : optionFailure,
      };
    }

    const forceAfterMs = invalidForceAfterMs
      ? this.options.defaultForceAfterMs
      : options.forceAfterMs ?? this.options.defaultForceAfterMs;
    const cleanupOptions = invalidForceAfterMs
      ? { ...options, forceAfterMs }
      : options;

    let cleanupOperation: Promise<void>;
    try {
      cleanupOperation = this.options.cleanup(cleanupOptions);
    } catch (error) {
      cleanupOperation = Promise.reject(error);
    }
    const cleanup = cleanupOperation.then(
      () => ({ kind: "closed" } as const),
      (error: unknown) => ({ kind: "failed", error } as const),
    );
    let resolveDeadline: (() => void) | undefined;
    const deadlineSignal = new Promise<void>((resolve) => {
      resolveDeadline = resolve;
    });
    const cancelDeadline = this.options.clock.schedule(forceAfterMs, () => resolveDeadline?.());
    try {
      const outcome = await Promise.race([
        cleanup,
        deadlineSignal.then(() => ({ kind: "deadline" } as const)),
      ]);
      if (outcome.kind === "closed") {
        return optionFailure
          ? { status: "failed", forced: false, message: optionFailure }
          : { status: "closed", forced: false };
      }
      if (outcome.kind === "failed") {
        const cleanupFailure = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
        return {
          status: "failed",
          forced: false,
          message: optionFailure ? `${optionFailure}; cleanup failed: ${cleanupFailure}` : cleanupFailure,
        };
      }
      const forced = await this.force("deadline");
      if (!optionFailure) return forced;
      return {
        status: "failed",
        forced: true,
        message: forced.status === "failed"
          ? `${optionFailure}; forced cleanup failed: ${forced.message}`
          : optionFailure,
      };
    } finally {
      cancelDeadline();
    }
  }

  private async force(reason: "requested" | "deadline"): Promise<AgentDriverCleanupResult> {
    try {
      await this.options.forceCleanup(reason);
      return { status: "closed", forced: true, forceReason: reason };
    } catch (error) {
      return {
        status: "failed",
        forced: true,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

class BufferedAgentDriverEvents {
  private readonly listeners = new Set<AgentDriverEventListener>();
  private readonly backlog: AgentDriverEvent[] = [];
  private activated = false;
  private closed = false;

  subscribe(listener: AgentDriverEventListener): () => void {
    if (this.closed) return () => undefined;
    this.listeners.add(listener);
    if (!this.activated) {
      this.activated = true;
      for (const event of this.backlog.splice(0)) listener(event);
    }
    return () => this.listeners.delete(listener);
  }

  publish(event: AgentDriverEvent): void {
    if (this.closed) return;
    if (!this.activated) {
      this.backlog.push(event);
      return;
    }
    for (const listener of this.listeners) listener(event);
  }

  close(): void {
    this.closed = true;
    this.backlog.splice(0);
    this.listeners.clear();
  }
}

export interface AgentDriverLogicalSessionOptions
  extends Omit<AgentDriverTurnCoordinatorOptions, "publish" | "sessionId" | "onFatal"> {
  readonly descriptor: AgentDriverDescriptor;
  readonly clock: AgentDriverClock;
  readonly defaultForceAfterMs: number;
  readonly sessionId: () => string | null;
  readonly cleanup: (options: AgentDriverCloseOptions) => Promise<void>;
  readonly forceCleanup: (reason: "requested" | "deadline") => Promise<void>;
}

/**
 * Runtime-neutral logical session used by both child-process and in-process
 * adapters. It buffers any fast open/handshake event until the first external
 * subscriber is attached, while the turn coordinator owns delivery identity,
 * queueing, provisional wire bindings, and exactly-once terminal results.
 */
export class AgentDriverLogicalSession implements AgentDriverSession {
  private readonly events = new BufferedAgentDriverEvents();
  private readonly coordinator: AgentDriverTurnCoordinator;
  private readonly controller: AgentDriverSessionController;

  constructor(options: AgentDriverLogicalSessionOptions) {
    this.coordinator = new AgentDriverTurnCoordinator({
      descriptor: options.descriptor,
      sessionId: options.sessionId,
      publish: (event) => this.events.publish(event),
      startTurn: options.startTurn,
      steerTurn: options.steerTurn,
      settleTurn: options.settleTurn,
      onFatal: () => this.handleCoordinatorFatal(),
      createTurnId: options.createTurnId,
    });
    this.controller = new AgentDriverSessionController({
      clock: options.clock,
      defaultForceAfterMs: options.defaultForceAfterMs,
      sessionId: options.sessionId,
      deliver: (prompt) => this.coordinator.deliver(prompt),
      cleanup: options.cleanup,
      forceCleanup: options.forceCleanup,
    });
  }

  get sessionId(): string | null {
    return this.controller.sessionId;
  }

  get closed(): boolean {
    return this.controller.closed;
  }

  subscribe(listener: AgentDriverEventListener): () => void {
    return this.events.subscribe(listener);
  }

  deliver(prompt: AgentDriverPrompt): Promise<AgentDriverReceipt> {
    return this.controller.deliver(prompt);
  }

  close(options: AgentDriverCloseOptions = {}): Promise<AgentDriverCleanupResult> {
    if (!this.controller.closed) {
      this.coordinator.abortAll(options.reason ?? "closed");
      this.events.close();
    }
    return this.controller.close(options);
  }

  publishSessionEvent(event: AgentDriverRuntimeSessionEvent): void {
    this.coordinator.publishSessionEvent(event);
  }

  flushGated(): Promise<void> {
    return this.coordinator.flushGated();
  }

  handleUnexpectedExit(reason = "runtime_exit"): Promise<AgentDriverCleanupResult> {
    return this.close({ reason });
  }

  get activeTurnId(): string | null {
    return this.coordinator.activeTurnId;
  }

  private handleCoordinatorFatal(): void {
    if (!this.controller.closed) void this.close({ reason: "turn_settlement_failed" });
  }
}
