import { describe, expect, it } from "vitest";
import {
  AGENT_DRIVER_CONTRACT_VERSION,
  AgentDriverToolCallLedger,
  AgentDriverTurnCoordinator,
  defineAgentDriverDescriptor,
  type AgentDriverDescriptor,
  type AgentDriverEvent,
  type AgentDriverPrompt,
  type AgentDriverTurnOperation,
  type AgentRuntimeId,
} from "./index.js";

function prompt(
  deliveryId: string,
  overrides: Partial<Omit<AgentDriverPrompt, "deliveryId">> = {},
): AgentDriverPrompt {
  return {
    deliveryId,
    text: deliveryId,
    mode: "initial",
    intent: "user",
    execution: "concrete",
    ...overrides,
  };
}

function descriptor(
  id: AgentRuntimeId,
  lifecycle: AgentDriverDescriptor["lifecycle"],
  transport: AgentDriverDescriptor["transport"] = { kind: "child_process", protocol: "jsonl" },
  missingSession: "fresh" | "error" | "create_with_requested_id" = "error",
): AgentDriverDescriptor {
  return defineAgentDriverDescriptor({
    contractVersion: AGENT_DRIVER_CONTRACT_VERSION,
    id,
    displayName: id,
    lifecycle,
    transport,
    terminal: { source: "protocol_event", processExit: "abort_active_turn" },
    resume: { kind: "by_id", missingSession },
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

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("AgentDriverTurnCoordinator", () => {
  it("publishes one fresh turn start before buffered synchronous events and never repeats it for steer", async () => {
    const events: AgentDriverEvent[] = [];
    const coordinator = new AgentDriverTurnCoordinator({
      descriptor: descriptor("pi", { kind: "persistent", busyDelivery: "direct_steer" }, { kind: "sdk" }, "create_with_requested_id"),
      sessionId: () => "session-1",
      publish: (event) => events.push(event),
      createTurnId: () => "turn-1",
      startTurn: (operation) => {
        operation.emit({ kind: "text", text: "sync start" });
      },
      steerTurn: (operation) => {
        operation.emit({ kind: "text", text: "sync steer" });
      },
    });

    await expect(coordinator.deliver(prompt("d1"))).resolves.toEqual({
      accepted: true,
      deliveryId: "d1",
      delivery: "prompt",
      turnId: "turn-1",
    });
    await expect(coordinator.deliver(prompt("d2", { mode: "busy" }))).resolves.toEqual({
      accepted: true,
      deliveryId: "d2",
      delivery: "steer",
      turnId: "turn-1",
    });

    expect(events.filter((event) => event.kind === "turn_started")).toEqual([
      { kind: "turn_started", turnId: "turn-1", deliveryIds: ["d1"], sessionId: "session-1" },
    ]);
    expect(events).toEqual([
      { kind: "turn_started", turnId: "turn-1", deliveryIds: ["d1"], sessionId: "session-1" },
      { kind: "delivery_bound", deliveryId: "d1", turnId: "turn-1" },
      { kind: "text", turnId: "turn-1", text: "sync start" },
      { kind: "delivery_bound", deliveryId: "d2", turnId: "turn-1" },
      { kind: "text", turnId: "turn-1", text: "sync steer" },
    ]);
  });

  it("does not leak synchronous events from a start or steer that throws", async () => {
    const startEvents: AgentDriverEvent[] = [];
    const failedStart = new AgentDriverTurnCoordinator({
      descriptor: descriptor("cursor", {
        kind: "per_turn",
        start: "immediate",
        exit: "natural",
        busyDelivery: "coalesce_next_turn",
      }),
      sessionId: () => null,
      publish: (event) => startEvents.push(event),
      startTurn: (operation) => {
        operation.emit({ kind: "text", text: "must not leak" });
        throw new Error("spawn failed");
      },
    });
    await expect(failedStart.deliver(prompt("d1"))).resolves.toEqual({
      accepted: false,
      deliveryId: "d1",
      reason: "runtime_error",
      message: "spawn failed",
    });
    expect(startEvents).toEqual([
      { kind: "delivery_result", result: { status: "error", deliveryId: "d1", message: "spawn failed" } },
    ]);

    const steerEvents: AgentDriverEvent[] = [];
    const failedSteer = new AgentDriverTurnCoordinator({
      descriptor: descriptor("pi", { kind: "persistent", busyDelivery: "direct_steer" }, { kind: "sdk" }),
      sessionId: () => null,
      publish: (event) => steerEvents.push(event),
      startTurn: () => undefined,
      steerTurn: (operation) => {
        operation.emit({ kind: "text", text: "must not leak" });
        throw new Error("steer failed");
      },
    });
    await failedSteer.deliver(prompt("d1"));
    await expect(failedSteer.deliver(prompt("d2", { mode: "busy" }))).resolves.toEqual({
      accepted: false,
      deliveryId: "d2",
      reason: "runtime_error",
      message: "steer failed",
    });
    expect(steerEvents).not.toContainEqual({ kind: "text", turnId: "turn-1", text: "must not leak" });
    expect(steerEvents).toContainEqual({
      kind: "delivery_result",
      result: { status: "error", deliveryId: "d2", message: "steer failed" },
    });
  });

  it("switches accepted start and steer callbacks live, then rejects late prior-turn events", async () => {
    const events: AgentDriverEvent[] = [];
    const starts: AgentDriverTurnOperation[] = [];
    const steers: AgentDriverTurnOperation[] = [];
    let ordinal = 0;
    const coordinator = new AgentDriverTurnCoordinator({
      descriptor: descriptor("pi", { kind: "persistent", busyDelivery: "direct_steer" }, { kind: "sdk" }),
      sessionId: () => "s",
      publish: (event) => events.push(event),
      createTurnId: () => `t${++ordinal}`,
      startTurn: (operation) => {
        starts.push(operation);
      },
      steerTurn: (operation) => {
        steers.push(operation);
      },
    });

    await coordinator.deliver(prompt("d1"));
    starts[0]!.emit({ kind: "text", text: "async start" });
    await coordinator.deliver(prompt("d2", { mode: "busy" }));
    steers[0]!.emit({ kind: "text", text: "async steer" });
    starts[0]!.emit({ kind: "turn_terminal", status: "clean", sessionId: "s" });

    await coordinator.deliver(prompt("d3", { mode: "idle" }));
    starts[0]!.emit({ kind: "text", text: "stale start" });
    steers[0]!.emit({ kind: "text", text: "stale steer" });
    starts[0]!.emit({ kind: "turn_terminal", status: "error", message: "stale terminal" });
    starts[1]!.emit({ kind: "text", text: "current turn" });

    expect(events).toContainEqual({ kind: "text", turnId: "t1", text: "async start" });
    expect(events).toContainEqual({ kind: "text", turnId: "t1", text: "async steer" });
    expect(events).toContainEqual({ kind: "text", turnId: "t2", text: "current turn" });
    expect(events).not.toContainEqual(expect.objectContaining({ text: "stale start" }));
    expect(events).not.toContainEqual(expect.objectContaining({ text: "stale steer" }));
    expect(events).not.toContainEqual(expect.objectContaining({ message: "stale terminal" }));
    expect(coordinator.activeTurnId).toBe("t2");
  });

  it("reuses one receipt and terminal ledger for same-id replay while active and after terminal", async () => {
    const events: AgentDriverEvent[] = [];
    let operation: AgentDriverTurnOperation | undefined;
    const coordinator = new AgentDriverTurnCoordinator({
      descriptor: descriptor("pi", { kind: "persistent", busyDelivery: "direct_steer" }, { kind: "sdk" }),
      sessionId: () => "s",
      publish: (event) => events.push(event),
      startTurn: (value) => {
        operation = value;
      },
      steerTurn: () => undefined,
    });
    const input = prompt("same");
    const original = coordinator.deliver(input);
    const activeReplay = coordinator.deliver(input);
    expect(activeReplay).toBe(original);
    const receipt = await original;

    operation!.emit({ kind: "turn_terminal", status: "clean", sessionId: "s" });
    const terminalReplay = coordinator.deliver(input);
    expect(terminalReplay).toBe(original);
    await expect(terminalReplay).resolves.toBe(receipt);
    await expect(coordinator.deliver({ ...input, text: "conflict" })).resolves.toMatchObject({
      accepted: false,
      reason: "duplicate_delivery_conflict",
    });

    expect(events.filter((event) => event.kind === "turn_started")).toHaveLength(1);
    expect(events.filter((event) => event.kind === "delivery_bound")).toHaveLength(1);
    expect(events.filter((event) => event.kind === "delivery_result")).toHaveLength(1);
    expect(events.filter((event) => event.kind === "turn_result")).toHaveLength(1);
  });

  it("keeps an unflushed gated delivery out of the current result and promotes it to a fresh turn", async () => {
    const events: AgentDriverEvent[] = [];
    const starts: string[][] = [];
    const operations: AgentDriverTurnOperation[] = [];
    let ordinal = 0;
    const coordinator = new AgentDriverTurnCoordinator({
      descriptor: descriptor("claude", { kind: "persistent", busyDelivery: "gated_steer_coalesce" }),
      sessionId: () => "s",
      publish: (event) => events.push(event),
      createTurnId: () => `t${++ordinal}`,
      startTurn: (operation) => {
        operations.push(operation);
        starts.push(operation.prompts.map((item) => item.deliveryId));
      },
      steerTurn: () => undefined,
    });
    await coordinator.deliver(prompt("d1"));
    await expect(coordinator.deliver(prompt("d2", { mode: "busy" }))).resolves.toEqual({
      accepted: true,
      deliveryId: "d2",
      delivery: "pending_gated",
    });

    operations[0]!.emit({ kind: "turn_terminal", status: "clean", sessionId: "s" });
    await settle();

    expect(starts).toEqual([["d1"], ["d2"]]);
    expect(events).toContainEqual({
      kind: "turn_result",
      result: { status: "clean", turnId: "t1", deliveryIds: ["d1"], sessionId: "s" },
    });
    expect(events).toContainEqual({ kind: "delivery_bound", deliveryId: "d2", turnId: "t2" });
    expect(events).not.toContainEqual(expect.objectContaining({
      kind: "delivery_result",
      result: expect.objectContaining({ deliveryId: "d2", turnId: "t1" }),
    }));
  });

  it("binds a gated batch only after a successful safe-boundary steer", async () => {
    const events: AgentDriverEvent[] = [];
    const steers: string[][] = [];
    const coordinator = new AgentDriverTurnCoordinator({
      descriptor: descriptor("codex", { kind: "persistent", busyDelivery: "gated_steer_coalesce" }, { kind: "child_process", protocol: "json_rpc" }, "fresh"),
      sessionId: () => "s",
      publish: (event) => events.push(event),
      createTurnId: () => "t1",
      startTurn: () => undefined,
      steerTurn: (operation) => {
        steers.push(operation.prompts.map((item) => item.deliveryId));
        operation.emit({ kind: "text", text: "after bind" });
      },
    });
    await coordinator.deliver(prompt("d1"));
    const replayA = coordinator.deliver(prompt("d2", { mode: "busy" }));
    const replayB = coordinator.deliver(prompt("d2", { mode: "busy" }));
    expect(replayB).toBe(replayA);
    await replayA;
    await coordinator.flushGated();

    expect(steers).toEqual([["d2"]]);
    expect(events.slice(-2)).toEqual([
      { kind: "delivery_bound", deliveryId: "d2", turnId: "t1" },
      { kind: "text", turnId: "t1", text: "after bind" },
    ]);
    expect(events.filter((event) => event.kind === "delivery_bound" && event.deliveryId === "d2")).toHaveLength(1);
  });

  it("binds a gated batch before a synchronous terminal and completes it on the current turn", async () => {
    const events: AgentDriverEvent[] = [];
    const coordinator = new AgentDriverTurnCoordinator({
      descriptor: descriptor("claude", { kind: "persistent", busyDelivery: "gated_steer_coalesce" }),
      sessionId: () => "s",
      publish: (event) => events.push(event),
      createTurnId: () => "t1",
      startTurn: () => undefined,
      steerTurn: (operation) => {
        operation.emit({ kind: "turn_terminal", status: "clean", sessionId: "s" });
      },
    });
    await coordinator.deliver(prompt("active"));
    await coordinator.deliver(prompt("gated", { mode: "busy" }));
    await coordinator.flushGated();

    const bindingIndex = events.findIndex((event) => event.kind === "delivery_bound" && event.deliveryId === "gated");
    const resultIndex = events.findIndex((event) => event.kind === "delivery_result" && event.result.deliveryId === "gated");
    expect(bindingIndex).toBeGreaterThan(-1);
    expect(resultIndex).toBeGreaterThan(bindingIndex);
    expect(events).toContainEqual({
      kind: "turn_result",
      result: { status: "clean", turnId: "t1", deliveryIds: ["active", "gated"], sessionId: "s" },
    });
    expect(coordinator.activeTurnId).toBeNull();
  });

  it("errors only a gated batch when safe-boundary wire throws and keeps the active turn", async () => {
    const events: AgentDriverEvent[] = [];
    const coordinator = new AgentDriverTurnCoordinator({
      descriptor: descriptor("codex", { kind: "persistent", busyDelivery: "gated_steer_coalesce" }),
      sessionId: () => "s",
      publish: (event) => events.push(event),
      createTurnId: () => "t1",
      startTurn: () => undefined,
      steerTurn: () => {
        throw new Error("wire failed");
      },
    });
    await coordinator.deliver(prompt("active"));
    await coordinator.deliver(prompt("gated", { mode: "busy" }));
    await coordinator.flushGated();

    expect(events).toContainEqual({
      kind: "delivery_result",
      result: { status: "error", deliveryId: "gated", message: "wire failed" },
    });
    expect(events).not.toContainEqual(expect.objectContaining({ kind: "delivery_bound", deliveryId: "gated" }));
    expect(events).not.toContainEqual(expect.objectContaining({ kind: "turn_result" }));
    expect(coordinator.activeTurnId).toBe("t1");
  });

  it("rejects a same-id conflict without disturbing the original pending promise", async () => {
    const coordinator = new AgentDriverTurnCoordinator({
      descriptor: descriptor("claude", { kind: "persistent", busyDelivery: "gated_steer_coalesce" }),
      sessionId: () => null,
      publish: () => undefined,
      startTurn: () => undefined,
      steerTurn: () => undefined,
    });
    await coordinator.deliver(prompt("d1"));
    const original = coordinator.deliver(prompt("d2", { mode: "busy", text: "same" }));
    const conflict = coordinator.deliver(prompt("d2", { mode: "busy", text: "changed" }));
    await expect(original).resolves.toMatchObject({ accepted: true, delivery: "pending_gated" });
    await expect(conflict).resolves.toMatchObject({ accepted: false, reason: "duplicate_delivery_conflict" });
  });

  it("defers only bookkeeping and starts concrete control work alone or interleaved", async () => {
    const batches: string[][] = [];
    const operations: AgentDriverTurnOperation[] = [];
    const events: AgentDriverEvent[] = [];
    const coordinator = new AgentDriverTurnCoordinator({
      descriptor: descriptor("opencode", {
        kind: "per_turn",
        start: "defer_until_concrete",
        exit: "terminate_on_turn_result",
        busyDelivery: "coalesce_next_turn",
      }),
      sessionId: () => null,
      publish: (event) => events.push(event),
      startTurn: (operation) => {
        operations.push(operation);
        batches.push(operation.prompts.map((item) => item.deliveryId));
      },
    });

    await expect(coordinator.deliver(prompt("book", {
      intent: "control",
      execution: "bookkeeping",
    }))).resolves.toMatchObject({ delivery: "deferred_bookkeeping" });
    expect(batches).toEqual([]);
    await coordinator.deliver(prompt("reset", { intent: "control", execution: "concrete" }));
    expect(batches).toEqual([["book", "reset"]]);

    operations[0]!.emit({ kind: "turn_terminal", status: "clean" });
    await settle();
    await coordinator.deliver(prompt("nap", { intent: "control", execution: "concrete" }));
    expect(batches).toEqual([["book", "reset"], ["nap"]]);
    await coordinator.deliver(prompt("book-after", {
      mode: "busy",
      intent: "control",
      execution: "bookkeeping",
    }));
    operations[1]!.emit({ kind: "turn_terminal", status: "clean" });
    await settle();
    expect(batches).toEqual([["book", "reset"], ["nap"]]);
    await coordinator.deliver(prompt("model-switch", { intent: "control", execution: "concrete" }));
    expect(batches).toEqual([["book", "reset"], ["nap"], ["book-after", "model-switch"]]);
    for (const deliveryId of ["book", "reset", "nap", "book-after", "model-switch"]) {
      expect(events.filter((event) => event.kind === "delivery_bound" && event.deliveryId === deliveryId)).toHaveLength(1);
    }
  });

  it("coalesces Cursor next-turn deliveries without text deduplication", async () => {
    const batches: AgentDriverPrompt[][] = [];
    const operations: AgentDriverTurnOperation[] = [];
    const events: AgentDriverEvent[] = [];
    const coordinator = new AgentDriverTurnCoordinator({
      descriptor: descriptor("cursor", {
        kind: "per_turn",
        start: "immediate",
        exit: "natural",
        busyDelivery: "coalesce_next_turn",
      }),
      sessionId: () => null,
      publish: (event) => events.push(event),
      startTurn: (operation) => {
        operations.push(operation);
        batches.push([...operation.prompts]);
      },
    });
    await coordinator.deliver(prompt("d1", { text: "same" }));
    await coordinator.deliver(prompt("d2", { mode: "busy", text: "same" }));
    await coordinator.deliver(prompt("d3", { mode: "busy", text: "same" }));
    operations[0]!.emit({ kind: "turn_terminal", status: "clean" });
    await settle();
    expect(batches.map((batch) => batch.map((item) => [item.deliveryId, item.text]))).toEqual([
      [["d1", "same"]],
      [["d2", "same"], ["d3", "same"]],
    ]);
    for (const deliveryId of ["d2", "d3"]) {
      expect(events.filter((event) => event.kind === "delivery_bound" && event.deliveryId === deliveryId)).toHaveLength(1);
    }
  });

  it("queues a delivery re-entered from turn_result onto a fresh physical turn", async () => {
    const batches: string[][] = [];
    const operations: AgentDriverTurnOperation[] = [];
    let reentered: Promise<unknown> | undefined;
    const coordinator = new AgentDriverTurnCoordinator({
      descriptor: descriptor("cursor", {
        kind: "per_turn",
        start: "immediate",
        exit: "natural",
        busyDelivery: "coalesce_next_turn",
      }),
      sessionId: () => null,
      publish: (event) => {
        if (event.kind === "turn_result" && !reentered) {
          reentered = coordinator.deliver(prompt("d2"));
        }
      },
      startTurn: (operation) => {
        operations.push(operation);
        batches.push(operation.prompts.map((item) => item.deliveryId));
      },
    });
    await coordinator.deliver(prompt("d1"));
    operations[0]!.emit({ kind: "turn_terminal", status: "clean" });
    await settle();
    await reentered;
    expect(batches).toEqual([["d1"], ["d2"]]);
  });

  it("terminalizes active and every unbound delivery exactly once on close/exit", async () => {
    const events: AgentDriverEvent[] = [];
    let operation: AgentDriverTurnOperation | undefined;
    const coordinator = new AgentDriverTurnCoordinator({
      descriptor: descriptor("claude", { kind: "persistent", busyDelivery: "gated_steer_coalesce" }),
      sessionId: () => "s",
      publish: (event) => events.push(event),
      startTurn: (value) => {
        operation = value;
      },
      steerTurn: () => undefined,
    });
    await coordinator.deliver(prompt("active"));
    await coordinator.deliver(prompt("pending", { mode: "busy" }));
    coordinator.abortAll("shutdown");
    coordinator.abortAll("late");
    operation?.emit({ kind: "turn_terminal", status: "clean" });

    const results = events.filter((event) => event.kind === "delivery_result");
    expect(results).toEqual([
      { kind: "delivery_result", result: { status: "aborted", deliveryId: "active", turnId: "turn-1", sessionId: "s", reason: "shutdown" } },
      { kind: "delivery_result", result: { status: "aborted", deliveryId: "pending", reason: "shutdown" } },
    ]);
    expect(events.filter((event) => event.kind === "turn_result")).toHaveLength(1);
  });
});

describe("AgentDriverToolCallLedger", () => {
  it("preserves native ids and correlates same-name out-of-order results", () => {
    const ledger = new AgentDriverToolCallLedger("turn-1");
    expect(ledger.start({ nativeId: "native-a", name: "read", input: { path: "a" } }).toolCallId).toBe("native-a");
    expect(ledger.start({ nativeId: "native-b", name: "read", input: { path: "b" } }).toolCallId).toBe("native-b");
    expect(ledger.finish({ nativeId: "native-b", name: "read", output: "b" }).toolCallId).toBe("native-b");
    expect(ledger.finish({ nativeId: "native-a", name: "read", output: "a" }).toolCallId).toBe("native-a");
  });

  it("uses a stable protocol identity for synthetic ids and refuses ambiguous guessing", () => {
    const ledger = new AgentDriverToolCallLedger("turn-1");
    const first = ledger.start({ protocolIdentity: "part-a", name: "shell", input: "a" });
    const second = ledger.start({ protocolIdentity: "part-b", name: "shell", input: "b" });
    expect(first.toolCallId).toBe("turn-1:tool:1");
    expect(second.toolCallId).toBe("turn-1:tool:2");
    expect(() => ledger.finish({ name: "shell" })).toThrow(/without a unique runtime identity/);
    expect(ledger.finish({ protocolIdentity: "part-b", name: "shell" }).toolCallId).toBe(second.toolCallId);
    expect(ledger.finish({ protocolIdentity: "part-a", name: "shell" }).toolCallId).toBe(first.toolCallId);
  });

  it("rejects a mismatched result name and retains the original call metadata", () => {
    const ledger = new AgentDriverToolCallLedger("turn-1");
    ledger.start({ nativeId: "native-a", name: "read", input: { path: "a" } });
    expect(() => ledger.finish({ nativeId: "native-a", name: "write", output: "wrong" }))
      .toThrow(/its call was read/);
    expect(ledger.outstandingIds).toEqual(["native-a"]);
    expect(ledger.finish({ nativeId: "native-a", name: "read", output: "ok" })).toEqual({
      kind: "tool_result",
      toolCallId: "native-a",
      name: "read",
      output: "ok",
      isError: undefined,
    });
  });

  it("terminalizes each unfinished tool call once while excluding completed calls", () => {
    const ledger = new AgentDriverToolCallLedger("turn-1");
    ledger.start({ nativeId: "done", name: "read", input: "a" });
    ledger.start({ nativeId: "open-a", name: "shell", input: "b" });
    ledger.start({ nativeId: "open-b", name: "write", input: "c" });
    ledger.finish({ nativeId: "done", name: "read", output: "ok" });

    expect(ledger.abortOutstanding("turn ended")).toEqual([
      { kind: "tool_result", toolCallId: "open-a", name: "shell", output: { reason: "turn ended" }, isError: true },
      { kind: "tool_result", toolCallId: "open-b", name: "write", output: { reason: "turn ended" }, isError: true },
    ]);
    expect(ledger.outstandingIds).toEqual([]);
    expect(ledger.abortOutstanding("late")).toEqual([]);
  });
});
