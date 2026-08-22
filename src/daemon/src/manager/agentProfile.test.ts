import { describe, it, expect } from "vitest";
import { AgentProcessManager } from "./managerRuntime";
import type { HostLaunchContext as LaunchContext } from "./hostContext.js";
import { makeRuntimeConfig } from "../runtimeConfig";
import type { AgentSessionResult } from "@alook/agent-driver";

/**
 * The daemon does not invent an agent's identity: when the server downlinks a
 * RuntimeConfig (via agent:wake → manager.register), its `instruction` becomes
 * the description on the host launch config. The daemon assembles the standing
 * prompt once, independently of the selected backend.
 */
function managerCapturingCtx(): {
  mgr: AgentProcessManager;
  ctxs: LaunchContext[];
} {
  const ctxs: LaunchContext[] = [];
  const mgr = new AgentProcessManager({
    driverFor: () => ({ id: "codex", capabilities: {} as never, probe: async () => ({} as never) }),
    baseContextFor: (agentId) => ({
      agentId,
      workingDirectory: "/tmp/x",
      config: {},
    }),
    sessionFactory: ({ ctx }) => {
      ctxs.push(ctx);
      return {
        backend: "codex" as const,
        capabilities: {} as never,
        sessionInstanceId: "agent-profile-test",
        events: {
          maxBufferedBytes: 4_194_304 as const,
          async *[Symbol.asyncIterator]() { await new Promise(() => {}); },
        },
        closed: new Promise<AgentSessionResult>(() => {}),
        async start(message: { id: string }) {
          return { status: "accepted" as const, delivery: "prompt" as const, commandId: message.id, turnId: "profile-turn" };
        },
        async send(message: { id: string }) {
          return { status: "accepted" as const, delivery: "steer" as const, commandId: message.id, turnId: "profile-turn" };
        },
        async interrupt() { return { status: "not_running" as const }; },
        async stop() { return { status: "accepted" as const, requestId: "profile-stop" }; },
        snapshot() {
          return { sessionInstanceId: "agent-profile-test", state: "working" as const, queuedCommands: [], lastEventSequence: 0 };
        },
        async invokeExtension() {
          return { ok: false as const, error: { category: "internal" as const, code: "unsupported", message: "unsupported", retryable: false } };
        },
      };
    },
    tickIntervalMs: 10_000,
  });
  return { mgr, ctxs };
}

describe("agent profile from server-downlinked RuntimeConfig", () => {
  it("assembles the standing prompt from the server-downlinked description", () => {
    const { mgr, ctxs } = managerCapturingCtx();
    mgr.register("agent_1", {
      runtimeConfig: makeRuntimeConfig({
        runtime: "mock",
        agentName: "Gus",
        instruction: "You are the onboarding assistant.",
      }),
    });
    mgr.deliver("agent_1", { seq: 1, text: "hello" });

    expect(ctxs).toHaveLength(1);
    expect(ctxs[0].standingPrompt).toContain("You are the onboarding assistant.");
    expect(ctxs[0].standingPrompt).toContain("### Role");
    expect(ctxs[0].config.description).toBe(
      "You are the onboarding assistant.",
    );
    expect(ctxs[0].config.runtimeConfig?.instruction).toBe(
      "You are the onboarding assistant.",
    );
  });

  it("uses the agent name as the fallback role description", () => {
    const { mgr, ctxs } = managerCapturingCtx();
    mgr.register("agent_2", {
      runtimeConfig: makeRuntimeConfig({ runtime: "mock", agentName: "Bot" }),
    });
    mgr.deliver("agent_2", { seq: 1, text: "hi" });
    expect(ctxs[0].standingPrompt).toContain("### Role");
    expect(ctxs[0].standingPrompt).toContain("Bot");
    expect(ctxs[0].config.description).toBe("Bot");
  });
});
