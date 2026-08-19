import { describe, expect, it } from "vitest";
import {
  AGENT_DRIVER_CONTRACT_VERSION,
  AgentDriverLogicalChildProcessSession,
  AgentDriverLogicalInProcessSession,
  defineAgentDriverDescriptor,
  verifyAgentDriverConformance,
  type AgentDriver,
  type AgentDriverDescriptor,
  type AgentDriverEvent,
  type AgentDriverHost,
  type AgentDriverReceipt,
  type AgentDriverTurnOperation,
  type AgentRuntimeId,
} from "./index.js";

const host: AgentDriverHost = {
  clock: {
    now: () => 0,
    schedule: (delayMs, callback) => {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    },
  },
  logger: { write: () => undefined },
  effects: {},
};

function define(
  id: AgentRuntimeId,
  lifecycle: AgentDriverDescriptor["lifecycle"],
  transport: AgentDriverDescriptor["transport"],
  missingSession: "fresh" | "error" | "create_with_requested_id",
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

const cases = [
  define("claude", { kind: "persistent", busyDelivery: "gated_steer_coalesce" }, { kind: "child_process", protocol: "jsonl" }, "error"),
  define("codex", { kind: "persistent", busyDelivery: "gated_steer_coalesce" }, { kind: "child_process", protocol: "json_rpc" }, "fresh"),
  define("cursor", {
    kind: "per_turn",
    start: "immediate",
    exit: "natural",
    busyDelivery: "coalesce_next_turn",
  }, { kind: "child_process", protocol: "jsonl" }, "error"),
  define("opencode", {
    kind: "per_turn",
    start: "defer_until_concrete",
    exit: "terminate_on_turn_result",
    busyDelivery: "coalesce_next_turn",
  }, { kind: "child_process", protocol: "jsonl" }, "error"),
  define("pi", { kind: "persistent", busyDelivery: "direct_steer" }, { kind: "sdk" }, "create_with_requested_id"),
] as const;

function fakeSession(descriptor: AgentDriverDescriptor): {
  session: AgentDriverLogicalChildProcessSession | AgentDriverLogicalInProcessSession;
  starts: AgentDriverTurnOperation[];
  steers: AgentDriverTurnOperation[];
} {
  const starts: AgentDriverTurnOperation[] = [];
  const steers: AgentDriverTurnOperation[] = [];
  let ordinal = 0;
  const options = {
    descriptor,
    clock: host.clock,
    defaultForceAfterMs: 25,
    sessionId: () => `session-${descriptor.id}`,
    createTurnId: () => `turn-${descriptor.id}-${++ordinal}`,
    startTurn: (operation: AgentDriverTurnOperation) => {
      starts.push(operation);
    },
    steerTurn: (operation: AgentDriverTurnOperation) => {
      steers.push(operation);
    },
    settlePhysicalTurn: async () => undefined,
    cleanup: async () => undefined,
    forceCleanup: async () => undefined,
  };
  const session = descriptor.transport.kind === "sdk"
    ? new AgentDriverLogicalInProcessSession(options)
    : new AgentDriverLogicalChildProcessSession(options);
  session.publishSessionEvent({ kind: "session", phase: "opened", sessionId: `session-${descriptor.id}` });
  return { session, starts, steers };
}

function fakeDriver(descriptor: AgentDriverDescriptor): AgentDriver {
  return {
    descriptor,
    probe: async () => ({ status: "healthy", version: "fake" }),
    open: async () => {
      // Simulates a vendor/process handshake racing open(). The logical core
      // must retain it until the conformance harness subscribes.
      return fakeSession(descriptor).session;
    },
  };
}

function delivery(descriptor: AgentDriverDescriptor, id: string, execution: "concrete" | "bookkeeping" = "concrete") {
  return {
    deliveryId: id,
    text: id,
    mode: id === "first" ? "initial" : "busy",
    intent: descriptor.id === "opencode" ? "control" : "user",
    execution,
  } as const;
}

describe("reusable descriptor/session conformance", () => {
  it.each(cases)("executes the declared $id strategy without a second descriptor", async (descriptor) => {
    const result = await verifyAgentDriverConformance({
      driver: fakeDriver(descriptor),
      launch: {
        identity: { agentId: "agent-1" },
        workingDirectory: "/workspace",
        standingPrompt: "",
        signal: new AbortController().signal,
        runtimeConfig: {},
        host,
      },
      firstPrompt: {
        deliveryId: `delivery-${descriptor.id}`,
        text: "hello",
        mode: "initial",
        intent: descriptor.id === "opencode" ? "control" : "user",
        execution: "concrete",
      },
    });

    expect(result.receipt).toMatchObject({
      accepted: true,
      delivery: "prompt",
      turnId: `turn-${descriptor.id}-1`,
    });
    expect(result.events[0]).toEqual({
      kind: "session",
      phase: "opened",
      sessionId: `session-${descriptor.id}`,
    });
    expect(result.events.filter((event) => event.kind === "turn_started")).toHaveLength(1);
    expect(result.events.filter((event) => event.kind === "turn_result")).toHaveLength(1);
    expect(result.events.filter(
      (event) => event.kind === "delivery_result" && event.result.deliveryId === `delivery-${descriptor.id}`,
    )).toHaveLength(1);
  });

  it.each(cases)("executes $id busy/deferred behavior from its descriptor", async (descriptor) => {
    const { session, starts, steers } = fakeSession(descriptor);
    const events: AgentDriverEvent[] = [];
    const acceptedDeliveryIds: string[] = [];
    session.subscribe((event) => events.push(event));

    if (descriptor.id === "opencode") {
      const bookkeeping = await session.deliver(delivery(descriptor, "bookkeeping", "bookkeeping"));
      expect(bookkeeping).toEqual({
        accepted: true,
        deliveryId: "bookkeeping",
        delivery: "deferred_bookkeeping",
      });
      if (bookkeeping.accepted) acceptedDeliveryIds.push(bookkeeping.deliveryId);
      expect(starts).toHaveLength(0);
    }

    const first = await session.deliver(delivery(descriptor, "first"));
    expect(first).toMatchObject({ accepted: true, delivery: "prompt" });
    if (!first.accepted || first.delivery !== "prompt") throw new Error("fake first delivery did not bind");
    acceptedDeliveryIds.push(first.deliveryId);
    const busy: AgentDriverReceipt = await session.deliver(delivery(descriptor, "busy"));
    if (busy.accepted) acceptedDeliveryIds.push(busy.deliveryId);

    if (descriptor.lifecycle.kind === "persistent") {
      if (descriptor.lifecycle.busyDelivery === "direct_steer") {
        expect(busy).toMatchObject({ delivery: "steer", turnId: first.turnId });
      } else {
        expect(busy).toEqual({ accepted: true, deliveryId: "busy", delivery: "pending_gated" });
        await session.flushGated();
      }
      expect(starts).toHaveLength(1);
      expect(steers).toHaveLength(1);
      expect(events.filter((event) => event.kind === "turn_started")).toHaveLength(1);
      starts[0]!.emit({ kind: "turn_terminal", status: "clean" });
    } else {
      expect(busy).toEqual({ accepted: true, deliveryId: "busy", delivery: "queued_next_turn" });
      starts[0]!.emit({ kind: "turn_terminal", status: "clean" });
      await Promise.resolve();
      await Promise.resolve();
      expect(starts).toHaveLength(2);
      expect(starts[1]!.prompts.map((prompt) => prompt.deliveryId)).toEqual(["busy"]);
      starts[1]!.emit({ kind: "turn_terminal", status: "clean" });
      await Promise.resolve();
    }

    for (const deliveryId of acceptedDeliveryIds) {
      expect(events.filter(
        (event) => event.kind === "delivery_result" && event.result.deliveryId === deliveryId,
      )).toHaveLength(1);
    }
    await session.close({ reason: "conformance complete" });
  });

  it("pins the corrected resume and honest single-flight descriptor facts", () => {
    expect(cases.find((item) => item.id === "claude")?.resume).toEqual({ kind: "by_id", missingSession: "error" });
    expect(cases.find((item) => item.id === "cursor")?.lifecycle).toMatchObject({ busyDelivery: "coalesce_next_turn" });
    expect(cases.find((item) => item.id === "opencode")?.lifecycle).toMatchObject({ busyDelivery: "coalesce_next_turn" });
    expect(cases.find((item) => item.id === "pi")?.resume).toEqual({
      kind: "by_id",
      missingSession: "create_with_requested_id",
    });
  });
});
