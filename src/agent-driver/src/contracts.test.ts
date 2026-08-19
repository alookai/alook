import { describe, expect, expectTypeOf, it } from "vitest";
import * as publicApi from "./index.js";
import {
  AGENT_RUNTIME_IDS,
  AGENT_DRIVER_CONTRACT_VERSION,
  AgentDriverContractError,
  assertAgentRuntimeId,
  defineAgentDriverDescriptor,
  isAgentRuntimeId,
  validateAgentDriverDescriptor,
  type AgentDriver,
  type AgentDriverCleanupResult,
  type AgentDriverDeliveryResult,
  type AgentDriverEvent,
  type AgentDriverHost,
  type AgentDriverArtifact,
  type AgentDriverReceipt,
  type AgentDriverSession,
} from "./index.js";

const host: AgentDriverHost = {
  clock: { now: () => 0, schedule: () => () => undefined },
  logger: { write: () => undefined },
  effects: {},
};

export function conformingDriver(eventSink: AgentDriverEvent[] = []): AgentDriver {
  const listeners = new Set<(event: AgentDriverEvent) => void>();
  let closePromise: Promise<AgentDriverCleanupResult> | undefined;
  const session: AgentDriverSession = {
    sessionId: null,
    closed: false,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    deliver: async (prompt) => {
      const turnId = `turn:${prompt.deliveryId}`;
      const events: AgentDriverEvent[] = [
        { kind: "session", phase: "opened", sessionId: "session-1" },
        { kind: "turn_started", turnId, deliveryIds: [prompt.deliveryId], sessionId: "session-1" },
        { kind: "delivery_bound", turnId, deliveryId: prompt.deliveryId },
        { kind: "text", turnId, text: "hello" },
        { kind: "delivery_result", result: { status: "clean", deliveryId: prompt.deliveryId, turnId, sessionId: "session-1" } },
        { kind: "turn_result", result: { status: "clean", turnId, deliveryIds: [prompt.deliveryId], sessionId: "session-1" } },
      ];
      for (const event of events) {
        eventSink.push(event);
        for (const listener of listeners) listener(event);
      }
      return { accepted: true, deliveryId: prompt.deliveryId, delivery: "prompt", turnId };
    },
    close: () => closePromise ??= Promise.resolve({ status: "closed", forced: false }),
  };

  return {
    descriptor: defineAgentDriverDescriptor({
      id: "codex",
      contractVersion: AGENT_DRIVER_CONTRACT_VERSION,
      displayName: "Codex",
      lifecycle: { kind: "persistent", busyDelivery: "gated_steer_coalesce" },
      transport: { kind: "child_process", protocol: "json_rpc" },
      terminal: { source: "protocol_event", processExit: "abort_active_turn" },
      resume: { kind: "by_id", missingSession: "fresh" },
      model: { detectedModels: "launchable", selection: "supported" },
      capabilities: {
        reasoningEffort: true,
        fastMode: true,
        disallowedTools: false,
        command: true,
        nativeStandingPrompt: true,
      },
    }),
    probe: async () => ({ status: "healthy", version: "1.0.0" }),
    open: async () => session,
  };
}

describe("agent driver public contract", () => {
  it("exports only transport-validating logical session cores", () => {
    expect("AgentDriverLogicalChildProcessSession" in publicApi).toBe(true);
    expect("AgentDriverLogicalInProcessSession" in publicApi).toBe(true);
    expect("AgentDriverLogicalSession" in publicApi).toBe(false);
  });

  it("pins the supported runtime ids", () => {
    expect(AGENT_RUNTIME_IDS).toEqual(["claude", "codex", "cursor", "opencode", "pi"]);
    expect(isAgentRuntimeId("pi")).toBe(true);
    for (const removed of ["gemini", "kimi", "copilot", "antigravity"]) {
      expect(isAgentRuntimeId(removed)).toBe(false);
      expect(() => assertAgentRuntimeId(removed)).toThrowError(AgentDriverContractError);
    }
  });

  it("accepts a conforming external driver", async () => {
    const driver = conformingDriver();
    expectTypeOf(driver).toMatchTypeOf<AgentDriver>();
    await expect(driver.probe(host)).resolves.toEqual({ status: "healthy", version: "1.0.0" });
  });

  it("opens inert, subscribes before the explicit first delivery, and correlates turn events", async () => {
    const emitted: AgentDriverEvent[] = [];
    const observed: AgentDriverEvent[] = [];
    const driver = conformingDriver(emitted);
    const session = await driver.open({
      identity: { agentId: "agent-1" },
      workingDirectory: "/workspace",
      standingPrompt: "Be useful",
      signal: new AbortController().signal,
      runtimeConfig: {},
      host,
    });

    expect(emitted).toEqual([]);
    const unsubscribe = session.subscribe((event) => observed.push(event));
    const receipt = await session.deliver({
      deliveryId: "delivery-1",
      text: "hello",
      mode: "initial",
      intent: "user",
      execution: "concrete",
    });
    unsubscribe();

    expect(receipt).toEqual({ accepted: true, deliveryId: "delivery-1", delivery: "prompt", turnId: "turn:delivery-1" });
    expect(observed).toEqual(emitted);
    expect(observed).toContainEqual({ kind: "text", turnId: "turn:delivery-1", text: "hello" });
    expect(observed.at(-1)).toEqual({
      kind: "turn_result",
      result: {
        status: "clean",
        turnId: "turn:delivery-1",
        deliveryIds: ["delivery-1"],
        sessionId: "session-1",
      },
    });
  });

  it("shares one cleanup operation and one result across racing close calls", async () => {
    const session = await conformingDriver().open({
      identity: { agentId: "agent-1" },
      workingDirectory: "/workspace",
      standingPrompt: "",
      signal: new AbortController().signal,
      runtimeConfig: {},
      host,
    });
    const first = session.close({ forceAfterMs: 1_000 });
    const second = session.close({ force: true });
    expect(second).toBe(first);
    await expect(first).resolves.toEqual({ status: "closed", forced: false });
    await expect(second).resolves.toEqual({ status: "closed", forced: false });
  });

  it("lets a conforming driver settle a pending open when the required signal aborts", async () => {
    const controller = new AbortController();
    const driver: AgentDriver = {
      ...conformingDriver(),
      open: (launch) => new Promise((_resolve, reject) => {
        launch.signal.addEventListener("abort", () => reject(new Error("open aborted")), { once: true });
      }),
    };
    const opening = driver.open({
      identity: { agentId: "agent-1" },
      workingDirectory: "/workspace",
      standingPrompt: "",
      signal: controller.signal,
      runtimeConfig: {},
      host,
    });

    controller.abort();
    await expect(opening).rejects.toThrow("open aborted");
  });

  it("keeps every acceptance and rejection receipt reason distinct", () => {
    const receipts: AgentDriverReceipt[] = [
      { accepted: true, deliveryId: "prompt", delivery: "prompt", turnId: "turn-1" },
      { accepted: true, deliveryId: "steer", delivery: "steer", turnId: "turn-1" },
      { accepted: true, deliveryId: "pending", delivery: "pending_gated" },
      { accepted: true, deliveryId: "queued", delivery: "queued_next_turn" },
      { accepted: true, deliveryId: "deferred", delivery: "deferred_bookkeeping" },
      { accepted: false, deliveryId: "closed", reason: "closed" },
      { accepted: false, deliveryId: "unsupported", reason: "unsupported" },
      { accepted: false, deliveryId: "runtime", reason: "runtime_error", message: "failed" },
      { accepted: false, deliveryId: "conflict", reason: "duplicate_delivery_conflict" },
    ];
    expect(receipts.map((receipt) => receipt.accepted ? receipt.delivery : receipt.reason)).toEqual([
      "prompt",
      "steer",
      "pending_gated",
      "queued_next_turn",
      "deferred_bookkeeping",
      "closed",
      "unsupported",
      "runtime_error",
      "duplicate_delivery_conflict",
    ]);
  });

  it("makes bound and unbound accepted receipts mutually exclusive at the type boundary", () => {
    // @ts-expect-error prompt is already wired and therefore requires turnId.
    const missingBoundTurn: AgentDriverReceipt = { accepted: true, deliveryId: "prompt", delivery: "prompt" };
    // @ts-expect-error queued work is not wired and therefore cannot carry turnId.
    const prematureQueuedTurn: AgentDriverReceipt = { accepted: true, deliveryId: "queued", delivery: "queued_next_turn", turnId: "turn-1" };
    expect([missingBoundTurn, prematureQueuedTurn]).toHaveLength(2);
  });

  it("requires a physical turn for a clean delivery result", () => {
    // @ts-expect-error clean completion is impossible before a delivery binds to a turn.
    const impossibleClean: AgentDriverDeliveryResult = { status: "clean", deliveryId: "unbound" };
    expect(impossibleClean.status).toBe("clean");
  });

  it("makes file and symlink host artifacts mutually exclusive", () => {
    const file: AgentDriverArtifact = { path: "AGENTS.md", kind: "file", content: "instructions" };
    const symlink: AgentDriverArtifact = { path: "CLAUDE.md", kind: "symlink", target: "AGENTS.md" };
    // @ts-expect-error file artifacts require content.
    const emptyFile: AgentDriverArtifact = { path: "empty", kind: "file" };
    // @ts-expect-error symlink artifacts require target.
    const emptyLink: AgentDriverArtifact = { path: "link", kind: "symlink" };
    // @ts-expect-error a file request cannot also carry a symlink target.
    const ambiguous: AgentDriverArtifact = { path: "both", kind: "file", content: "x", target: "other" };
    expect([file, symlink, emptyFile, emptyLink, ambiguous]).toHaveLength(5);
  });

  it("freezes a validated descriptor", () => {
    const descriptor = conformingDriver().descriptor;
    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(Object.isFrozen(descriptor.lifecycle)).toBe(true);
    expect(Object.isFrozen(descriptor.capabilities)).toBe(true);
  });

  it("rejects an invalid runtime descriptor at runtime", () => {
    expect(() => validateAgentDriverDescriptor({
      ...conformingDriver().descriptor,
      id: "gemini",
    })).toThrowError(/Unsupported agent runtime: gemini/);
  });

  it("rejects a driver built for another runtime contract version", () => {
    expect(() => validateAgentDriverDescriptor({
      ...conformingDriver().descriptor,
      contractVersion: 2,
    })).toThrowError(expect.objectContaining<Partial<AgentDriverContractError>>({
      code: "unsupported_contract_version",
    }));
  });

  it("requires every public descriptor field at compile time", () => {
    if (false) {
      // @ts-expect-error capabilities are required by the public descriptor
      const invalid = defineAgentDriverDescriptor({ id: "codex" });
      expect(invalid).toBeDefined();
    }
    expect(true).toBe(true);
  });
});
