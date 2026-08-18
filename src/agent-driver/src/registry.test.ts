import { describe, expect, it } from "vitest";
import {
  AgentDriverContractError,
  AGENT_DRIVER_CONTRACT_VERSION,
  createAgentDriverRegistry,
  defineAgentDriverDescriptor,
  type AgentDriver,
  type AgentDriverDescriptor,
  type AgentDriverHost,
} from "./index.js";

const host: AgentDriverHost = {
  clock: { now: () => 0, schedule: () => () => undefined },
  logger: { write: () => undefined },
  effects: {},
};

function conformingDriver(): AgentDriver {
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
    probe: async () => ({ status: "healthy" }),
    open: async () => ({
      sessionId: null,
      closed: false,
      subscribe: () => () => undefined,
      deliver: async (prompt) => ({ accepted: true, deliveryId: prompt.deliveryId, delivery: "prompt" }),
      close: async () => ({ status: "closed", forced: false }),
    }),
  };
}

describe("agent driver registry", () => {
  it("registers and resolves an explicit driver", () => {
    const driver = conformingDriver();
    const registry = createAgentDriverRegistry([driver]);
    expect(registry.get("codex")).not.toBe(driver);
    expect(registry.get("codex").descriptor).toEqual(driver.descriptor);
    expect(registry.listRuntimeIds()).toEqual(["codex"]);
    expect(registry.listDescriptors()).toEqual([driver.descriptor]);
  });

  it("snapshots descriptors so later external mutation cannot change registry facts", async () => {
    const descriptor: AgentDriverDescriptor = {
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
    };
    const driver = { ...conformingDriver(), descriptor };
    const registry = createAgentDriverRegistry([driver]);
    const mutable = descriptor as unknown as {
      displayName: string;
      capabilities: { fastMode: boolean };
    };
    mutable.displayName = "Changed";
    mutable.capabilities.fastMode = false;
    expect(registry.get("codex").descriptor.displayName).toBe("Codex");
    expect(registry.get("codex").descriptor.capabilities.fastMode).toBe(true);
    expect(Object.isFrozen(registry.get("codex").descriptor)).toBe(true);
    await expect(registry.get("codex").probe(host)).resolves.toEqual({ status: "healthy" });
  });

  it("rejects duplicate registrations", () => {
    const driver = conformingDriver();
    expect(() => createAgentDriverRegistry([driver, driver])).toThrowError(
      expect.objectContaining<Partial<AgentDriverContractError>>({ code: "duplicate_runtime" }),
    );
  });

  it("distinguishes unsupported and unregistered runtimes", () => {
    const registry = createAgentDriverRegistry();
    expect(() => registry.get("gemini")).toThrowError(
      expect.objectContaining<Partial<AgentDriverContractError>>({ code: "unsupported_runtime" }),
    );
    expect(() => registry.get("claude")).toThrowError(
      expect.objectContaining<Partial<AgentDriverContractError>>({ code: "runtime_not_registered" }),
    );
  });

  it("rejects a registered driver from another contract version", () => {
    const driver = conformingDriver();
    const incompatible = {
      ...driver,
      descriptor: { ...driver.descriptor, contractVersion: 2 },
    } as unknown as AgentDriver;
    expect(() => createAgentDriverRegistry([incompatible])).toThrowError(
      expect.objectContaining<Partial<AgentDriverContractError>>({ code: "unsupported_contract_version" }),
    );
  });
});
