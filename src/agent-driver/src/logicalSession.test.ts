import { describe, expect, it } from "vitest";
import {
  AGENT_DRIVER_CONTRACT_VERSION,
  AgentDriverLogicalChildProcessSession,
  AgentDriverLogicalInProcessSession,
  defineAgentDriverDescriptor,
  type AgentDriverClock,
  type AgentDriverDescriptor,
  type AgentDriverEvent,
  type AgentDriverPrompt,
  type AgentDriverTurnOperation,
} from "./index.js";

class ManualClock implements AgentDriverClock {
  private readonly callbacks = new Set<() => void>();
  now(): number {
    return 0;
  }
  schedule(_delayMs: number, callback: () => void): () => void {
    this.callbacks.add(callback);
    return () => this.callbacks.delete(callback);
  }
  elapse(): void {
    for (const callback of [...this.callbacks]) {
      this.callbacks.delete(callback);
      callback();
    }
  }
}

function descriptor(transport: "child" | "sdk" = "child"): AgentDriverDescriptor {
  return defineAgentDriverDescriptor({
    contractVersion: AGENT_DRIVER_CONTRACT_VERSION,
    id: transport === "child" ? "claude" : "pi",
    displayName: transport,
    lifecycle: transport === "child"
      ? { kind: "persistent", busyDelivery: "gated_steer_coalesce" }
      : { kind: "persistent", busyDelivery: "direct_steer" },
    transport: transport === "child"
      ? { kind: "child_process", protocol: "jsonl" }
      : { kind: "sdk" },
    terminal: { source: "protocol_event", processExit: "abort_active_turn" },
    resume: {
      kind: "by_id",
      missingSession: transport === "child" ? "error" : "create_with_requested_id",
    },
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

function prompt(deliveryId: string): AgentDriverPrompt {
  return {
    deliveryId,
    text: deliveryId,
    mode: "initial",
    intent: "user",
    execution: "concrete",
  };
}

function perTurnDescriptor(exit: "natural" | "terminate_on_turn_result"): AgentDriverDescriptor {
  return defineAgentDriverDescriptor({
    ...descriptor(),
    id: exit === "natural" ? "cursor" : "opencode",
    lifecycle: {
      kind: "per_turn",
      start: exit === "natural" ? "immediate" : "defer_until_concrete",
      exit,
      busyDelivery: "coalesce_next_turn",
    },
  });
}

describe("logical session cores", () => {
  it("buffers a fast handshake until the first external subscriber is attached", () => {
    const session = new AgentDriverLogicalChildProcessSession({
      descriptor: descriptor(),
      clock: new ManualClock(),
      defaultForceAfterMs: 25,
      sessionId: () => "session-1",
      startTurn: () => undefined,
      steerTurn: () => undefined,
      cleanup: async () => undefined,
      forceCleanup: async () => undefined,
    });
    session.publishSessionEvent({ kind: "session", phase: "opened", sessionId: "session-1" });
    session.publishSessionEvent({ kind: "diagnostic", source: "handshake", message: "ready" });
    const observed: AgentDriverEvent[] = [];
    session.subscribe((event) => observed.push(event));
    expect(observed).toEqual([
      { kind: "session", phase: "opened", sessionId: "session-1" },
      { kind: "diagnostic", source: "handshake", message: "ready" },
    ]);
  });

  it("shares a same-id pending delivery promise and terminalizes it deterministically on close", async () => {
    let releaseStart: (() => void) | undefined;
    const session = new AgentDriverLogicalInProcessSession({
      descriptor: descriptor("sdk"),
      clock: new ManualClock(),
      defaultForceAfterMs: 25,
      sessionId: () => "session-1",
      startTurn: () => new Promise<void>((resolve) => {
        releaseStart = resolve;
      }),
      steerTurn: () => undefined,
      cleanup: async () => undefined,
      forceCleanup: async () => undefined,
    });
    const events: AgentDriverEvent[] = [];
    session.subscribe((event) => events.push(event));
    const first = session.deliver(prompt("d1"));
    const replay = session.deliver(prompt("d1"));
    expect(replay).toBe(first);

    const closing = session.close({ reason: "shutdown" });
    await expect(first).resolves.toEqual({ accepted: false, deliveryId: "d1", reason: "closed" });
    await expect(closing).resolves.toEqual({ status: "closed", forced: false });
    releaseStart?.();
    await Promise.resolve();
    expect(events).toEqual([
      { kind: "delivery_result", result: { status: "aborted", deliveryId: "d1", reason: "shutdown" } },
    ]);
  });

  it("bounds cleanup and validates the descriptor transport for each core", async () => {
    const clock = new ManualClock();
    const session = new AgentDriverLogicalInProcessSession({
      descriptor: descriptor("sdk"),
      clock,
      defaultForceAfterMs: 25,
      sessionId: () => null,
      startTurn: () => undefined,
      steerTurn: () => undefined,
      cleanup: () => new Promise(() => undefined),
      forceCleanup: async () => undefined,
    });
    const closing = session.close();
    clock.elapse();
    await expect(closing).resolves.toEqual({ status: "closed", forced: true, forceReason: "deadline" });

    expect(() => new AgentDriverLogicalChildProcessSession({
      descriptor: descriptor("sdk"),
      clock,
      defaultForceAfterMs: 25,
      sessionId: () => null,
      startTurn: () => undefined,
      cleanup: async () => undefined,
      forceCleanup: async () => undefined,
    })).toThrow(/child_process descriptor/);
  });

  it.each(["natural", "terminate_on_turn_result"] as const)(
    "waits for %s child settlement before promoting the next physical turn",
    async (exit) => {
      const operations: AgentDriverTurnOperation[] = [];
      let releasePhysicalTurn: (() => void) | undefined;
      const physicalTurnReleased = new Promise<void>((resolve) => {
        releasePhysicalTurn = resolve;
      });
      const settlements: Array<{ turnId: string; exit: string }> = [];
      let ordinal = 0;
      const session = new AgentDriverLogicalChildProcessSession({
        descriptor: perTurnDescriptor(exit),
        clock: new ManualClock(),
        defaultForceAfterMs: 25,
        sessionId: () => "session-1",
        createTurnId: () => `turn-${++ordinal}`,
        startTurn: (operation) => {
          operations.push(operation);
        },
        settlePhysicalTurn: async (settlement) => {
          settlements.push({ turnId: settlement.turnId, exit: settlement.exit });
          await physicalTurnReleased;
        },
        cleanup: async () => undefined,
        forceCleanup: async () => undefined,
      });

      await expect(session.deliver(prompt("d1"))).resolves.toMatchObject({
        delivery: "prompt",
        turnId: "turn-1",
      });
      await expect(session.deliver({ ...prompt("d2"), mode: "busy" })).resolves.toEqual({
        accepted: true,
        deliveryId: "d2",
        delivery: "queued_next_turn",
      });
      operations[0]!.emit({ kind: "turn_terminal", status: "clean", sessionId: "session-1" });
      await Promise.resolve();

      expect(settlements).toEqual([{ turnId: "turn-1", exit }]);
      expect(operations).toHaveLength(1);

      releasePhysicalTurn?.();
      await Promise.resolve();
      await Promise.resolve();
      expect(operations).toHaveLength(2);
      expect(operations[1]!.prompts.map((item) => item.deliveryId)).toEqual(["d2"]);
      await session.close({ reason: "test complete" });
    },
  );

  it("requires a physical settlement hook for per-turn child sessions", () => {
    expect(() => new AgentDriverLogicalChildProcessSession({
      descriptor: perTurnDescriptor("natural"),
      clock: new ManualClock(),
      defaultForceAfterMs: 25,
      sessionId: () => null,
      startTurn: () => undefined,
      cleanup: async () => undefined,
      forceCleanup: async () => undefined,
    })).toThrow(/requires settlePhysicalTurn/);
  });

  it("closes and cleans up a logical session when physical turn settlement fails", async () => {
    const operations: AgentDriverTurnOperation[] = [];
    const cleanupReasons: Array<string | undefined> = [];
    const events: AgentDriverEvent[] = [];
    const session = new AgentDriverLogicalChildProcessSession({
      descriptor: perTurnDescriptor("natural"),
      clock: new ManualClock(),
      defaultForceAfterMs: 25,
      sessionId: () => "session-1",
      startTurn: (operation) => {
        operations.push(operation);
      },
      settlePhysicalTurn: async () => {
        throw new Error("physical exit failed");
      },
      cleanup: async (options) => {
        cleanupReasons.push(options.reason);
      },
      forceCleanup: async () => undefined,
    });
    session.subscribe((event) => events.push(event));

    await session.deliver(prompt("active"));
    await session.deliver({ ...prompt("queued"), mode: "busy" });
    operations[0]!.emit({ kind: "turn_terminal", status: "clean", sessionId: "session-1" });
    await Promise.resolve();
    await Promise.resolve();

    expect(session.closed).toBe(true);
    expect(cleanupReasons).toEqual(["turn_settlement_failed"]);
    await expect(session.deliver(prompt("late"))).resolves.toEqual({
      accepted: false,
      deliveryId: "late",
      reason: "closed",
    });
    expect(operations).toHaveLength(1);
    expect(events.filter((event) => event.kind === "delivery_result")).toEqual([
      {
        kind: "delivery_result",
        result: { status: "clean", deliveryId: "active", turnId: "turn-1", sessionId: "session-1" },
      },
      {
        kind: "delivery_result",
        result: { status: "error", deliveryId: "queued", message: "physical exit failed" },
      },
    ]);
    expect(events.filter((event) => event.kind === "turn_result")).toHaveLength(1);
    await expect(session.close()).resolves.toEqual({ status: "closed", forced: false });
    expect(cleanupReasons).toEqual(["turn_settlement_failed"]);
  });
});
