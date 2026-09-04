import { describe, it, expect } from "vitest";
import {
  assertAdapterCompatibility, BUILTIN_BACKEND_IDS, capabilitiesFor, createAgentDriverRegistry,
  createBuiltinAgentDriverRegistry,
} from "./registry.js";
import type { BackendCapabilities, BuiltinBackendId } from "./contract.js";
import { ADAPTER_AUTHOR_CONTRACT_VERSION } from "./adapter-author.js";

/**
 * Every driver declares which `RuntimeConfig` fields it actually consumes,
 * per the plan's capability matrix. This test pins that declaration so a
 * silent drift (e.g. someone adds `reasoningEffort` to a driver's `buildArgs`
 * without updating `capabilities`) trips CI.
 */
const EXPECTED: Record<BuiltinBackendId, BackendCapabilities> = {
  claude: { modelSelection: "launchable", providerConfiguration: true, reasoningEffort: true, fastMode: true, disallowedTools: true, commandOverride: true, resume: "by_id", sessionLifetime: "persistent", midTurnDelivery: "safe_boundary_queue", interrupt: true },
  codex: { modelSelection: "launchable", providerConfiguration: false, reasoningEffort: true, fastMode: true, disallowedTools: false, commandOverride: true, resume: "by_id", sessionLifetime: "persistent", midTurnDelivery: "safe_boundary_queue", interrupt: true },
  cursor: { modelSelection: "launchable", providerConfiguration: false, reasoningEffort: false, fastMode: false, disallowedTools: false, commandOverride: true, resume: "by_id", sessionLifetime: "persistent", midTurnDelivery: "steer", interrupt: true },
  opencode: { modelSelection: "launchable", providerConfiguration: false, reasoningEffort: false, fastMode: false, disallowedTools: false, commandOverride: true, resume: "by_id", sessionLifetime: "persistent", midTurnDelivery: "steer", interrupt: true },
  pi: { modelSelection: "launchable", providerConfiguration: true, reasoningEffort: true, fastMode: false, disallowedTools: false, commandOverride: false, resume: "by_id", sessionLifetime: "persistent", midTurnDelivery: "steer", interrupt: true },
};

describe("driver.capabilities", () => {
  it.each(BUILTIN_BACKEND_IDS)("%s declares the expected capability record", (id) => {
    expect(capabilitiesFor(id)).toEqual(EXPECTED[id]);
  });

  it("pins the orthogonal built-in execution matrix and adapter-author version", () => {
    expect(ADAPTER_AUTHOR_CONTRACT_VERSION).toBe(1);
    const registry = createBuiltinAgentDriverRegistry();
    const expected = {
      claude: {
        lifetime: "session",
        transport: { kind: "stdio_stream", protocol: "claude.stream-json.v1" },
        wakeStart: "immediate",
        terminalOwnership: "vendor_message",
      },
      codex: {
        lifetime: "session",
        transport: { kind: "stdio_rpc", protocol: "codex.app-server.v1" },
        wakeStart: "immediate",
        terminalOwnership: "transport_request",
        turnSilence: {
          nativeIdleTimeoutMs: 300_000,
          daemonGraceMs: 60_000,
          recoveryGraceMs: 60_000,
          maxRecoveryExtensions: 1,
        },
      },
      cursor: {
        lifetime: "session",
        transport: { kind: "stdio_rpc", protocol: "cursor.acp.v1" },
        wakeStart: "immediate",
        terminalOwnership: "transport_request",
      },
      opencode: {
        lifetime: "session",
        transport: { kind: "http_sse", protocol: "opencode.v2.service.1.17.20" },
        wakeStart: "immediate",
        terminalOwnership: "transport_request",
      },
      pi: {
        lifetime: "session",
        transport: { kind: "in_process_sdk", protocol: "pi_sdk" },
        wakeStart: "immediate",
        terminalOwnership: "prompt_invocation",
      },
    } as const;
    for (const id of BUILTIN_BACKEND_IDS) {
      const registration = registry.get(id);
      expect(registration.contractVersion).toBe(1);
      expect(registration.createAdapter().execution).toEqual(expected[id]);
    }
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
      contractVersion: 1 as const,
      capabilities: EXPECTED.claude,
      createAdapter: () => ({}),
    };
    expect(() => createAgentDriverRegistry([registration, registration] as never)).toThrow("Duplicate agent backend registration");
  });

  it("accepts the public suggestion_only model-selection capability for extension adapters", () => {
    const registration = {
      id: "sixth",
      contractVersion: 1 as const,
      capabilities: { ...EXPECTED.claude, modelSelection: "suggestion_only" },
      createAdapter: () => ({}),
    };
    expect(createAgentDriverRegistry([registration] as never).backendIds).toEqual(["sixth"]);
  });

  it("rejects each malformed registration capability and adapter shape at runtime", () => {
    const valid = {
      id: "sixth",
      contractVersion: 1 as const,
      capabilities: EXPECTED.claude,
      createAdapter: () => new (class {
        id = "sixth";
        instructionDelivery = { kind: "native" } as const;
        execution = {
          lifetime: "session",
          transport: { kind: "stdio_stream", protocol: "sixth.test.v1" },
          wakeStart: "immediate",
          terminalOwnership: "vendor_message",
        } as const;
        currentSessionId = null;
        probe() { return { status: "healthy" as const }; }
        async discoverRecentContext() {
          return { sessionFiles: { capability: "unavailable" as const, items: [] }, recentProjects: [] };
        }
        normalizeLine() { return []; }
        encodeMessage() { return ""; }
        async openLane() { throw new Error("not opened by registration tests"); }
        async spawn() { return { process: {} }; }
      })(),
    };
    expect(() => createAgentDriverRegistry([{ ...valid, capabilities: null }] as never)).toThrow("requires capabilities");
    expect(() => createAgentDriverRegistry([{ ...valid, capabilities: { ...EXPECTED.claude, resume: "bad" } }] as never)).toThrow("invalid capability resume");
    expect(() => createAgentDriverRegistry([{ ...valid, capabilities: { ...EXPECTED.claude, interrupt: "yes" } }] as never)).toThrow("invalid capability interrupt");
    expect(() => createAgentDriverRegistry([{ ...valid, createAdapter: null }] as never)).toThrow("requires createAdapter");
  });

  it("fails closed for missing, old, and unknown adapter-author contract versions", () => {
    const valid = {
      id: "sixth",
      contractVersion: 1,
      capabilities: EXPECTED.claude,
      createAdapter: () => ({}),
    };
    for (const contractVersion of [undefined, 0, 2]) {
      expect(() => createAgentDriverRegistry([{ ...valid, contractVersion }] as never))
        .toThrow("unsupported adapter-author contract version");
    }
  });

  it("rejects next-turn delivery adapters that declare a per-turn execution", () => {
    const adapter = {
      id: "sixth",
      instructionDelivery: { kind: "native" },
      execution: {
        lifetime: "turn",
        transport: { kind: "one_shot_cli", protocol: "sixth.test.v1" },
        wakeStart: "immediate",
        terminalOwnership: "lane_generation",
      },
      probe() {},
      discoverRecentContext() {},
      openLane() {},
    };
    expect(() => assertAdapterCompatibility(
      "sixth",
      { ...EXPECTED.claude, sessionLifetime: "per_turn" },
      adapter,
    )).toThrow("delivery conflicts with its execution lifetime");
  });

  it("accepts a missing recent-context hook but rejects a malformed optional hook", () => {
    const adapter = {
      id: "sixth",
      instructionDelivery: { kind: "native" },
      execution: {
        lifetime: "session",
        transport: { kind: "stdio_stream", protocol: "sixth.test.v1" },
        wakeStart: "immediate",
        terminalOwnership: "vendor_message",
      },
      probe() {},
      openLane() {},
    };
    expect(() => assertAdapterCompatibility("sixth", EXPECTED.claude, adapter)).not.toThrow();
    expect(() => assertAdapterCompatibility(
      "sixth",
      EXPECTED.claude,
      { ...adapter, discoverRecentContext: "not-a-function" },
    )).toThrow("invalid discoverRecentContext");
  });

  it("rejects malformed turn-silence policies instead of disabling stall detection", () => {
    const adapter = {
      id: "sixth",
      instructionDelivery: { kind: "native" },
      execution: {
        lifetime: "session",
        transport: { kind: "stdio_stream", protocol: "sixth.test.v1" },
        wakeStart: "immediate",
        terminalOwnership: "vendor_message",
        turnSilence: {
          nativeIdleTimeoutMs: 300_000,
          daemonGraceMs: 60_000,
          recoveryGraceMs: 60_000,
          maxRecoveryExtensions: 1,
        },
      },
      probe() {},
      discoverRecentContext() {},
      openLane() {},
    };
    const invalidPolicies = [
      null,
      { ...adapter.execution.turnSilence, nativeIdleTimeoutMs: 0 },
      { ...adapter.execution.turnSilence, daemonGraceMs: -1 },
      { ...adapter.execution.turnSilence, recoveryGraceMs: Number.POSITIVE_INFINITY },
      { ...adapter.execution.turnSilence, maxRecoveryExtensions: 0.5 },
      { ...adapter.execution.turnSilence, nativeIdleTimeoutMs: Number.MAX_SAFE_INTEGER, daemonGraceMs: 1 },
    ];
    for (const turnSilence of invalidPolicies) {
      expect(() => assertAdapterCompatibility(
        "sixth",
        EXPECTED.claude,
        { ...adapter, execution: { ...adapter.execution, turnSilence } },
      )).toThrow("invalid turnSilence declaration");
    }
  });
});
