import { describe, it, expect } from "vitest";
import { BUILTIN_BACKEND_IDS, capabilitiesFor, createAgentDriverRegistry } from "./registry.js";
import type { BackendCapabilities, BuiltinBackendId } from "./contract.js";

/**
 * Every driver declares which `RuntimeConfig` fields it actually consumes,
 * per the plan's capability matrix. This test pins that declaration so a
 * silent drift (e.g. someone adds `reasoningEffort` to a driver's `buildArgs`
 * without updating `capabilities`) trips CI.
 */
const EXPECTED: Record<BuiltinBackendId, BackendCapabilities> = {
  claude: { modelSelection: "launchable", providerConfiguration: true, reasoningEffort: true, fastMode: true, disallowedTools: true, commandOverride: true, resume: "by_id", midTurnDelivery: "safe_boundary_queue", interrupt: true },
  codex: { modelSelection: "launchable", providerConfiguration: false, reasoningEffort: true, fastMode: true, disallowedTools: false, commandOverride: true, resume: "by_id", midTurnDelivery: "safe_boundary_queue", interrupt: true },
  cursor: { modelSelection: "launchable", providerConfiguration: false, reasoningEffort: false, fastMode: false, disallowedTools: false, commandOverride: true, resume: "by_id", midTurnDelivery: "next_turn_queue", interrupt: true },
  opencode: { modelSelection: "launchable", providerConfiguration: false, reasoningEffort: false, fastMode: false, disallowedTools: false, commandOverride: true, resume: "by_id", midTurnDelivery: "next_turn_queue", interrupt: true },
  pi: { modelSelection: "launchable", providerConfiguration: true, reasoningEffort: true, fastMode: false, disallowedTools: false, commandOverride: false, resume: "by_id", midTurnDelivery: "steer", interrupt: true },
};

describe("driver.capabilities", () => {
  it.each(BUILTIN_BACKEND_IDS)("%s declares the expected capability record", (id) => {
    expect(capabilitiesFor(id)).toEqual(EXPECTED[id]);
  });
});

describe("adapter registration runtime boundary", () => {
  it("rejects malformed registrations and duplicate ids at construction", () => {
    expect(() => createAgentDriverRegistry([null] as never)).toThrow("Invalid agent backend registration");
    expect(() => createAgentDriverRegistry([{
      id: "",
      capabilities: {},
      createAdapter: () => ({}),
    }] as never)).toThrow("non-empty id");
    const registration = {
      id: "sixth",
      capabilities: EXPECTED.claude,
      createAdapter: () => ({}),
    };
    expect(() => createAgentDriverRegistry([registration, registration] as never)).toThrow("Duplicate agent backend registration");
  });

  it("accepts the public suggestion_only model-selection capability for extension adapters", () => {
    const registration = {
      id: "sixth",
      capabilities: { ...EXPECTED.claude, modelSelection: "suggestion_only" },
      createAdapter: () => ({}),
    };
    expect(createAgentDriverRegistry([registration] as never).backendIds).toEqual(["sixth"]);
  });

  it("rejects each malformed registration capability and adapter shape at runtime", () => {
    const valid = {
      id: "sixth",
      capabilities: EXPECTED.claude,
      createAdapter: () => new (class {
        id = "sixth";
        instructionDelivery = { kind: "native" } as const;
        execution = { kind: "persistent_process", input: "direct" } as const;
        currentSessionId = null;
        probe() { return { status: "healthy" as const }; }
        normalizeLine() { return []; }
        encodeMessage() { return ""; }
        async spawn() { return { process: {} }; }
      })(),
    };
    expect(() => createAgentDriverRegistry([{ ...valid, capabilities: null }] as never)).toThrow("requires capabilities");
    expect(() => createAgentDriverRegistry([{ ...valid, capabilities: { ...EXPECTED.claude, resume: "bad" } }] as never)).toThrow("invalid capability resume");
    expect(() => createAgentDriverRegistry([{ ...valid, capabilities: { ...EXPECTED.claude, interrupt: "yes" } }] as never)).toThrow("invalid capability interrupt");
    expect(() => createAgentDriverRegistry([{ ...valid, createAdapter: null }] as never)).toThrow("requires createAdapter");
  });
});
