import type {
  AgentDriverCleanupResult,
  AgentDriverCloseOptions,
  AgentDriverEvent,
  AgentDriverEventListener,
  AgentDriverPrompt,
  AgentDriverReceipt,
  AgentDriverSession,
} from "./contracts.js";
import type { AgentDriverClock } from "./host.js";

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
    return Promise.race([
      delivery,
      this.closeSignal.then(() => ({
        accepted: false,
        deliveryId: prompt.deliveryId,
        reason: "closed",
      } as const)),
    ]);
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
