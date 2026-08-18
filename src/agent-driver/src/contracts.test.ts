import { describe, expect, expectTypeOf, it } from "vitest";
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
  type AgentDriverEvent,
  type AgentDriverHost,
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
      const events: AgentDriverEvent[] = [
        { kind: "session", phase: "opened", sessionId: "session-1" },
        { kind: "text", deliveryId: prompt.deliveryId, text: "hello" },
        { kind: "turn_result", result: { status: "clean", deliveryId: prompt.deliveryId, sessionId: "session-1" } },
      ];
      for (const event of events) {
        eventSink.push(event);
        for (const listener of listeners) listener(event);
      }
      return { accepted: true, deliveryId: prompt.deliveryId, delivery: "prompt" };
    },
    close: () => closePromise ??= Promise.resolve({ status: "closed", forced: false }),
  };

  return {
    descriptor: defineAgentDriverDescriptor({
      id: "codex",
      contractVersion: AGENT_DRIVER_CONTRACT_VERSION,
      displayName: "Codex",
      lifecycle: { kind: "persistent", input: "gated", inFlightDelivery: "queue" },
      transport: { kind: "child_process", protocol: "json_rpc" },
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
    const receipt = await session.deliver({ deliveryId: "delivery-1", text: "hello", mode: "initial" });
    unsubscribe();

    expect(receipt).toEqual({ accepted: true, deliveryId: "delivery-1", delivery: "prompt" });
    expect(observed).toEqual(emitted);
    expect(observed).toContainEqual({ kind: "text", deliveryId: "delivery-1", text: "hello" });
    expect(observed.at(-1)).toEqual({
      kind: "turn_result",
      result: { status: "clean", deliveryId: "delivery-1", sessionId: "session-1" },
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
      { accepted: true, deliveryId: "prompt", delivery: "prompt" },
      { accepted: true, deliveryId: "steer", delivery: "steer" },
      { accepted: true, deliveryId: "queued", delivery: "queued" },
      { accepted: false, deliveryId: "closed", reason: "closed" },
      { accepted: false, deliveryId: "unsupported", reason: "unsupported" },
      { accepted: false, deliveryId: "runtime", reason: "runtime_error", message: "failed" },
    ];
    expect(receipts.map((receipt) => receipt.accepted ? receipt.delivery : receipt.reason)).toEqual([
      "prompt",
      "steer",
      "queued",
      "closed",
      "unsupported",
      "runtime_error",
    ]);
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
