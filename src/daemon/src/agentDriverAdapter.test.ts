import { describe, expect, it } from "vitest";
import {
  AGENT_DRIVER_CONTRACT_VERSION,
  defineAgentDriverDescriptor,
  type AgentDriver,
  type AgentDriverCloseOptions,
  type AgentDriverEvent,
  type AgentDriverEventListener,
  type AgentDriverHost,
  type AgentDriverPrompt,
  type AgentDriverReceipt,
  type AgentDriverSession,
} from "@alook/agent-driver";
import { AgentDriverManagedSession, parsedEventsFromAgentDriverEvent } from "./agentDriverAdapter.js";

const host: AgentDriverHost = {
  clock: { now: () => 0, schedule: () => () => undefined },
  logger: { write: () => undefined },
  effects: {},
};

function descriptor() {
  return defineAgentDriverDescriptor({
    id: "pi",
    contractVersion: AGENT_DRIVER_CONTRACT_VERSION,
    displayName: "Pi",
    lifecycle: { kind: "persistent", busyDelivery: "direct_steer" },
    transport: { kind: "sdk" },
    terminal: { source: "protocol_event", processExit: "abort_active_turn" },
    resume: { kind: "by_id", missingSession: "create_with_requested_id" },
    model: { detectedModels: "launchable", selection: "supported" },
    capabilities: {
      reasoningEffort: true,
      fastMode: false,
      disallowedTools: false,
      command: true,
      nativeStandingPrompt: true,
    },
  });
}

class FakeSession implements AgentDriverSession {
  readonly delivered: AgentDriverPrompt[] = [];
  readonly closeOptions: Array<AgentDriverCloseOptions | undefined> = [];
  private readonly listeners = new Set<AgentDriverEventListener>();
  readonly sessionId = "sdk-session";
  closed = false;
  private closePromise: Promise<{ status: "closed"; forced: false }> | null = null;

  constructor(
    private readonly receiptForPrompt?: (
      prompt: AgentDriverPrompt,
    ) => AgentDriverReceipt | Promise<AgentDriverReceipt> | undefined,
    private readonly closeOperation?: () => Promise<{ status: "closed"; forced: false }>,
  ) {}

  subscribe(listener: AgentDriverEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async deliver(prompt: AgentDriverPrompt): Promise<AgentDriverReceipt> {
    this.delivered.push(prompt);
    return await this.receiptForPrompt?.(prompt)
      ?? {
        accepted: true,
        deliveryId: prompt.deliveryId,
        delivery: prompt.mode === "busy" ? "steer" : "prompt",
        turnId: "turn-1",
      };
  }

  close(options?: AgentDriverCloseOptions): Promise<{ status: "closed"; forced: false }> {
    this.closeOptions.push(options);
    this.closed = true;
    this.closePromise ??= this.closeOperation?.() ?? Promise.resolve({ status: "closed", forced: false });
    return this.closePromise;
  }

  emit(event: AgentDriverEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function adapter(session: FakeSession, ids = ["initial", "next"]): AgentDriverManagedSession<AgentDriverHost> {
  const driver: AgentDriver = {
    descriptor: descriptor(),
    probe: async () => ({ status: "healthy" }),
    open: async () => session,
  };
  let index = 0;
  return new AgentDriverManagedSession({
    driver,
    launch: {
      identity: { agentId: "agent-1" },
      workingDirectory: "/workspace",
      standingPrompt: "Be useful",
      runtimeConfig: {},
      host,
    },
    createDeliveryId: () => ids[index++] ?? `extra-${index}`,
  });
}

describe("AgentDriverManagedSession", () => {
  it("subscribes before explicitly delivering the first prompt", async () => {
    const session = new FakeSession();
    const managed = adapter(session);
    const events: unknown[] = [];
    managed.on("runtime_event", (event) => events.push(event));

    await expect(managed.start({ text: "hello", sessionId: "resume-1" })).resolves.toEqual({ ok: true });
    expect(session.delivered).toEqual([{
      deliveryId: "initial",
      text: "hello",
      mode: "initial",
      intent: "user",
      execution: "concrete",
    }]);
    expect(events).toEqual([]);

    session.emit({ kind: "session", phase: "resumed", sessionId: "resume-1" });
    session.emit({ kind: "text", turnId: "turn-1", text: "answer" });
    session.emit({
      kind: "turn_result",
      result: { status: "clean", turnId: "turn-1", deliveryIds: ["initial"], sessionId: "resume-1" },
    });
    expect(events).toEqual([
      { kind: "session_init", sessionId: "resume-1" },
      { kind: "text", text: "answer" },
      { kind: "turn_end", sessionId: "resume-1" },
    ]);
    expect(managed.currentSessionId).toBe("resume-1");
  });

  it("translates daemon idle/busy sends without adding queue policy", async () => {
    const session = new FakeSession();
    const managed = adapter(session);
    await managed.start({ text: "first" });
    expect(managed.send({ text: "steer", mode: "busy" })).toEqual({ ok: true });
    await Promise.resolve();
    expect(session.delivered).toEqual([
      { deliveryId: "initial", text: "first", mode: "initial" },
      { deliveryId: "next", text: "steer", mode: "busy" },
    ].map((item) => ({ ...item, intent: "user" as const, execution: "concrete" as const })));
  });

  it("emits one daemon turn_end for one physical turn despite multiple delivery results and a late duplicate", async () => {
    const session = new FakeSession();
    const managed = adapter(session);
    const events: unknown[] = [];
    managed.on("runtime_event", (event) => events.push(event));
    await managed.start({ text: "first" });

    session.emit({
      kind: "delivery_result",
      result: { status: "clean", deliveryId: "initial", turnId: "turn-1", sessionId: "s" },
    });
    session.emit({
      kind: "delivery_result",
      result: { status: "clean", deliveryId: "next", turnId: "turn-1", sessionId: "s" },
    });
    const terminal: AgentDriverEvent = {
      kind: "turn_result",
      result: { status: "clean", turnId: "turn-1", deliveryIds: ["initial", "next"], sessionId: "s" },
    };
    session.emit(terminal);
    session.emit(terminal);

    expect(events).toEqual([{ kind: "turn_end", sessionId: "s" }]);
  });

  it("surfaces an asynchronous delivery rejection as a normalized runtime error", async () => {
    const session = new FakeSession((prompt) => prompt.mode === "busy" ? {
      accepted: false,
      deliveryId: prompt.deliveryId,
      reason: "runtime_error",
      message: "vendor busy",
    } : undefined);
    const managed = adapter(session);
    const events: unknown[] = [];
    managed.on("runtime_event", (event) => events.push(event));
    await managed.start({ text: "first" });
    expect(managed.send({ text: "second", mode: "busy" })).toEqual({ ok: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual([{ kind: "error", message: "vendor busy" }]);
  });

  it.each([
    {
      name: "rejected receipt",
      deliver: (prompt: AgentDriverPrompt) => ({
        accepted: false,
        deliveryId: prompt.deliveryId,
        reason: "runtime_error",
        message: "initial refused",
      } satisfies AgentDriverReceipt),
      message: "initial refused",
    },
    {
      name: "thrown delivery",
      deliver: async () => {
        throw new Error("initial crashed");
      },
      message: "initial crashed",
    },
  ])("closes and unsubscribes when the initial delivery is $name", async ({ deliver, message }) => {
    const session = new FakeSession(deliver);
    const managed = adapter(session);
    const events: unknown[] = [];
    let exits = 0;
    managed.on("runtime_event", (event) => events.push(event));
    managed.on("exit", () => exits++);

    await expect(managed.start({ text: "first" })).rejects.toThrow(message);
    session.emit({ kind: "text", turnId: "turn-1", text: "must not escape" });
    await managed.stop();

    expect(events).toEqual([]);
    expect(session.closed).toBe(true);
    expect(session.closeOptions).toEqual([undefined]);
    expect(exits).toBe(1);
  });

  it("runs one bounded cleanup and emits exit once across repeated stops", async () => {
    const session = new FakeSession();
    const managed = adapter(session);
    let exits = 0;
    managed.on("exit", () => exits++);
    await managed.start({ text: "first" });
    const first = managed.stop({ reason: "idle", forceAfterMs: 250 });
    const second = managed.stop({ reason: "other", forceAfterMs: 0 });
    expect(second).toBe(first);
    await first;
    expect(session.closeOptions).toEqual([{ reason: "idle", forceAfterMs: 250, force: false }]);
    expect(exits).toBe(1);
  });

  it("closes a session opened during a racing stop without delivering the first prompt", async () => {
    let resolveClose: (() => void) | undefined;
    let signalCloseStarted: (() => void) | undefined;
    const closeStarted = new Promise<void>((resolve) => {
      signalCloseStarted = resolve;
    });
    const session = new FakeSession(undefined, () => new Promise((resolve) => {
      signalCloseStarted?.();
      resolveClose = () => resolve({ status: "closed", forced: false });
    }));
    let resolveOpen: ((session: AgentDriverSession) => void) | undefined;
    let openSignal: AbortSignal | undefined;
    const driver: AgentDriver = {
      descriptor: descriptor(),
      probe: async () => ({ status: "healthy" }),
      open: (launch) => new Promise((resolve) => {
        openSignal = launch.signal;
        resolveOpen = resolve;
      }),
    };
    const managed = new AgentDriverManagedSession({
      driver,
      launch: {
        identity: { agentId: "agent-1" },
        workingDirectory: "/workspace",
        standingPrompt: "",
        runtimeConfig: {},
        host,
      },
    });
    const events: unknown[] = [];
    let exits = 0;
    managed.on("runtime_event", (event) => events.push(event));
    managed.on("exit", () => exits++);
    const starting = managed.start({ text: "first" });
    let startSettled = false;
    void starting.finally(() => {
      startSettled = true;
    });
    const stopping = managed.stop({ forceAfterMs: 25 });
    expect(openSignal?.aborted).toBe(true);
    resolveOpen?.(session);
    await closeStarted;
    expect(startSettled).toBe(false);
    session.emit({ kind: "text", turnId: "turn-late", text: "must not escape" });
    expect(events).toEqual([]);
    resolveClose?.();
    await Promise.all([starting, stopping]);
    expect(session.delivered).toEqual([]);
    expect(session.closeOptions).toEqual([{ reason: undefined, forceAfterMs: 25, force: false }]);
    expect(exits).toBe(1);
  });

  it("aborts a pending conforming open so start and stop both settle", async () => {
    let openSignal: AbortSignal | undefined;
    const driver: AgentDriver = {
      descriptor: descriptor(),
      probe: async () => ({ status: "healthy" }),
      open: (launch) => {
        openSignal = launch.signal;
        return new Promise((_resolve, reject) => {
          launch.signal.addEventListener("abort", () => reject(new Error("open aborted")), { once: true });
        });
      },
    };
    const managed = new AgentDriverManagedSession({
      driver,
      launch: {
        identity: { agentId: "agent-1" },
        workingDirectory: "/workspace",
        standingPrompt: "",
        runtimeConfig: {},
        host,
      },
    });
    let exits = 0;
    managed.on("exit", () => exits++);

    const starting = managed.start({ text: "first" });
    const startingFailure = expect(starting).rejects.toThrow("open aborted");
    await expect(managed.stop()).resolves.toBeUndefined();
    await startingFailure;

    expect(openSignal?.aborted).toBe(true);
    expect(exits).toBe(1);
  });

  it("closes an opened session without waiting for a hanging initial delivery", async () => {
    let signalDeliveryStarted: (() => void) | undefined;
    const deliveryStarted = new Promise<void>((resolve) => {
      signalDeliveryStarted = resolve;
    });
    let settleDelivery: (() => void) | undefined;
    const session = new FakeSession(
      (prompt) => new Promise((resolve) => {
        signalDeliveryStarted?.();
        settleDelivery = () => resolve({ accepted: false, deliveryId: prompt.deliveryId, reason: "closed" });
      }),
      async () => {
        settleDelivery?.();
        return { status: "closed", forced: false };
      },
    );
    const managed = adapter(session);
    const events: unknown[] = [];
    let exits = 0;
    managed.on("runtime_event", (event) => events.push(event));
    managed.on("exit", () => exits++);

    const starting = managed.start({ text: "first" });
    await deliveryStarted;
    const stopping = managed.stop({ forceAfterMs: 25 });
    await expect(stopping).resolves.toBeUndefined();
    await expect(starting).rejects.toThrow("Agent driver rejected delivery: closed");
    session.emit({ kind: "text", turnId: "turn-1", text: "must not escape" });

    expect(events).toEqual([]);
    expect(session.closeOptions).toEqual([{ reason: undefined, forceAfterMs: 25, force: false }]);
    expect(exits).toBe(1);
  });
});

describe("parsedEventsFromAgentDriverEvent", () => {
  it.each<[AgentDriverEvent, unknown]>([
    [{ kind: "thinking", turnId: "turn", text: "thought" }, [{ kind: "thinking", text: "thought" }]],
    [{ kind: "tool_call", turnId: "turn", toolCallId: "t", name: "read", input: { path: "a" } }, [{ kind: "tool_call", name: "read", input: { path: "a" } }]],
    [{ kind: "tool_result", turnId: "turn", toolCallId: "t", name: "read", output: "ok" }, [{ kind: "tool_output", name: "read" }]],
    [{ kind: "compaction", turnId: "turn", phase: "started" }, [{ kind: "compaction_started" }]],
    [{ kind: "review", turnId: "turn", phase: "finished" }, [{ kind: "review_finished" }]],
    [{ kind: "progress", turnId: "turn", source: "codex", itemType: "reasoning", payloadBytes: 4 }, [{ kind: "internal_progress", source: "codex", itemType: "reasoning", payloadBytes: 4 }]],
    [{ kind: "diagnostic", turnId: "turn", severity: "warn", source: "runtime", message: "slow" }, [{ kind: "runtime_diagnostic", severity: "warn", source: "runtime", message: "slow" }]],
    [{ kind: "telemetry", turnId: "turn", name: "token_usage", source: "codex", attributes: { total: 3 } }, [{ kind: "telemetry", name: "token_usage", source: "codex", attrs: { total: 3 } }]],
    [{ kind: "delivery_result", result: { status: "error", deliveryId: "d", message: "failed" } }, [{ kind: "runtime_diagnostic", severity: "warn", source: "agent-driver-delivery", message: "Delivery d failed: failed" }]],
    [{ kind: "turn_result", result: { status: "error", turnId: "turn", deliveryIds: ["d"], sessionId: "s", message: "failed" } }, [{ kind: "error", message: "failed" }, { kind: "turn_end", sessionId: "s" }]],
    [{ kind: "turn_result", result: { status: "aborted", turnId: "turn", deliveryIds: ["d"], sessionId: "s", reason: "stop" } }, [{ kind: "runtime_diagnostic", severity: "info", source: "agent-driver", message: "Turn aborted: stop" }, { kind: "turn_end", sessionId: "s" }]],
  ])("maps %s", (event, expected) => {
    expect(parsedEventsFromAgentDriverEvent(event)).toEqual(expected);
  });
});
