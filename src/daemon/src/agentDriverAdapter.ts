import { EventEmitter } from "node:events";
import type {
  AgentDriver,
  AgentDriverCloseOptions,
  AgentDriverEvent,
  AgentDriverHost,
  AgentDriverLaunch,
  AgentDriverReceipt,
  AgentDriverSession,
} from "@alook/agent-driver";
import type { ParsedEvent } from "./types.js";

export interface AgentDriverManagedSessionOptions<THost extends AgentDriverHost> {
  readonly driver: AgentDriver<THost>;
  readonly launch: Omit<AgentDriverLaunch<THost>, "signal">;
  readonly createDeliveryId?: () => string;
}

function parsedEventsFromAgentDriverEvent(event: AgentDriverEvent): ParsedEvent[] {
  switch (event.kind) {
    case "session":
      return [{ kind: "session_init", sessionId: event.sessionId }];
    case "turn_started":
    case "delivery_bound":
      return [];
    case "thinking":
      return [{ kind: "thinking", text: event.text }];
    case "text":
      return [{ kind: "text", text: event.text }];
    case "tool_call":
      return [{ kind: "tool_call", name: event.name, input: event.input }];
    case "tool_result":
      return [{ kind: "tool_output", name: event.name }];
    case "compaction":
      return [{ kind: event.phase === "started" ? "compaction_started" : "compaction_finished" }];
    case "review":
      return [{ kind: event.phase === "started" ? "review_started" : "review_finished" }];
    case "progress":
      return [{
        kind: "internal_progress",
        source: event.source,
        itemType: event.itemType,
        payloadBytes: event.payloadBytes,
      }];
    case "diagnostic":
      return [{
        kind: "runtime_diagnostic",
        severity: event.severity,
        source: event.source,
        message: event.message,
      }];
    case "telemetry":
      return [{
        kind: "telemetry",
        name: event.name,
        source: event.source,
        attrs: { ...event.attributes },
      }];
    case "delivery_result":
      if (event.result.status === "clean") return [];
      return [{
        kind: "runtime_diagnostic",
        severity: event.result.status === "error" ? "warn" : "info",
        source: "agent-driver-delivery",
        message: event.result.status === "error"
          ? `Delivery ${event.result.deliveryId} failed: ${event.result.message}`
          : `Delivery ${event.result.deliveryId} aborted: ${event.result.reason}`,
      }];
    case "turn_result":
      if (event.result.status === "error") {
        return [
          { kind: "error", message: event.result.message },
          { kind: "turn_end", sessionId: event.result.sessionId },
        ];
      }
      if (event.result.status === "aborted") {
        return [
          {
            kind: "runtime_diagnostic",
            severity: "info",
            source: "agent-driver",
            message: `Turn aborted: ${event.result.reason}`,
          },
          { kind: "turn_end", sessionId: event.result.sessionId },
        ];
      }
      return [{ kind: "turn_end", sessionId: event.result.sessionId }];
  }
}

function receiptError(receipt: Extract<AgentDriverReceipt, { accepted: false }>): Error {
  return new Error(receipt.message ?? `Agent driver rejected delivery: ${receipt.reason}`);
}

export class AgentDriverManagedSession<THost extends AgentDriverHost> {
  private readonly events = new EventEmitter();
  private readonly driver: AgentDriver<THost>;
  private readonly launch: Omit<AgentDriverLaunch<THost>, "signal">;
  private readonly createDeliveryId: () => string;
  private readonly openAbortController = new AbortController();
  private session: AgentDriverSession | null = null;
  private opening: Promise<void> | null = null;
  private starting: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  private closingSession: Promise<void> | null = null;
  private unsubscribe: (() => void) | null = null;
  private observedSessionId: string | null = null;
  private deliveryOrdinal = 0;
  private readonly terminalTurnIds = new Set<string>();
  private stopRequested = false;
  private exited = false;

  constructor(options: AgentDriverManagedSessionOptions<THost>) {
    this.driver = options.driver;
    this.launch = options.launch;
    this.createDeliveryId = options.createDeliveryId ?? (() => `delivery-${++this.deliveryOrdinal}`);
  }

  on(event: string, listener: (...args: unknown[]) => void): void {
    this.events.on(event, listener);
  }

  start(input: { text: string; sessionId?: string }): Promise<{ ok: boolean }> {
    if (this.stopRequested) return Promise.reject(new Error("Agent driver session is closed"));
    this.opening ??= this.openSession(input.sessionId);
    this.starting ??= this.startSession(input.text);
    return this.waitForStart();
  }

  private async waitForStart(): Promise<{ ok: boolean }> {
    await this.starting;
    if (this.stopRequested && this.stopping) await this.stopping;
    return { ok: true };
  }

  private async openSession(sessionId?: string): Promise<void> {
    const launch: AgentDriverLaunch<THost> = {
      ...this.launch,
      resumeSessionId: sessionId ?? this.launch.resumeSessionId,
      signal: this.openAbortController.signal,
    };
    const session = await this.driver.open(launch);
    this.session = session;
    this.observedSessionId = session.sessionId;
    if (this.stopRequested) return;
    this.unsubscribe = session.subscribe((event) => this.forwardEvent(event));
  }

  private async startSession(text: string): Promise<void> {
    await this.opening;
    if (this.stopRequested) return;
    const session = this.session;
    if (!session) throw new Error("Agent driver session did not open");

    try {
      const receipt = await session.deliver({
        deliveryId: this.createDeliveryId(),
        text,
        mode: "initial",
        intent: "user",
        execution: "concrete",
      });
      if (!receipt.accepted) throw receiptError(receipt);
    } catch (error) {
      this.stopRequested = true;
      try {
        await this.closeOpenedSession();
      } finally {
        this.emitExit();
      }
      throw error;
    }
  }

  send(input: { text: string; mode: "busy" | "idle" }): { ok: boolean; reason?: string } {
    const session = this.session;
    if (!session || this.stopRequested) return { ok: false, reason: this.stopRequested ? "closed" : "not_started" };

    void session.deliver({
      deliveryId: this.createDeliveryId(),
      text: input.text,
      mode: input.mode,
      intent: "user",
      execution: "concrete",
    }).then((receipt) => {
      if (!receipt.accepted) this.emitRuntimeError(receiptError(receipt));
    }).catch((error: unknown) => this.emitRuntimeError(error));
    return { ok: true };
  }

  stop(options?: { reason?: string; forceAfterMs?: number }): Promise<void> {
    this.stopRequested = true;
    this.openAbortController.abort(options?.reason);
    if (!this.stopping) {
      this.stopping = this.stopSession({
        reason: options?.reason,
        forceAfterMs: options?.forceAfterMs,
        force: options?.forceAfterMs === 0,
      });
    }
    return this.stopping;
  }

  private async stopSession(options?: AgentDriverCloseOptions): Promise<void> {
    try {
      if (this.opening) await this.opening.catch(() => undefined);
      await this.closeOpenedSession(options);
    } finally {
      this.emitExit();
    }
  }

  private closeOpenedSession(options?: AgentDriverCloseOptions): Promise<void> {
    if (!this.session) return Promise.resolve();
    if (!this.closingSession) {
      this.unsubscribe?.();
      this.unsubscribe = null;
      const session = this.session;
      this.closingSession = Promise.resolve().then(() => session.close(options)).then((result) => {
        if (result.status === "failed") throw new Error(result.message);
      });
    }
    return this.closingSession;
  }

  private forwardEvent(event: AgentDriverEvent): void {
    if (event.kind === "session") this.observedSessionId = event.sessionId;
    if (event.kind === "turn_result") {
      if (this.terminalTurnIds.has(event.result.turnId)) return;
      this.terminalTurnIds.add(event.result.turnId);
    }
    for (const parsed of parsedEventsFromAgentDriverEvent(event)) {
      this.events.emit("runtime_event", parsed);
    }
  }

  private emitRuntimeError(error: unknown): void {
    this.events.emit("runtime_event", {
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    } satisfies ParsedEvent);
  }

  private emitExit(): void {
    if (this.exited) return;
    this.exited = true;
    this.events.emit("exit", { reason: "requested" });
  }

  get currentSessionId(): string | null {
    return this.observedSessionId ?? this.session?.sessionId ?? null;
  }
}

export { parsedEventsFromAgentDriverEvent };
