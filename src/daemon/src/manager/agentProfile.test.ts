import { describe, it, expect } from "vitest";
import { AgentProcessManager } from "./managerRuntime";
import type { LaunchContext } from "../types";
import { makeRuntimeConfig } from "../runtimeConfig";

/**
 * The daemon does not invent an agent's identity: when the server downlinks a
 * RuntimeConfig (via agent:start → manager.register), its `instruction` becomes
 * the description on the LaunchConfig. The driver's `buildSystemPrompt(config)`
 * is called to assemble the full standing prompt — the daemon never passes raw
 * instruction text as the prompt.
 */
function managerCapturingCtx(): { mgr: AgentProcessManager; ctxs: LaunchContext[] } {
  const ctxs: LaunchContext[] = [];
  const mgr = new AgentProcessManager({
    driverFor: () =>
      ({
        lifecycle: { kind: "persistent" },
        supportsStdinNotification: true,
        busyDeliveryMode: "gated",
        buildSystemPrompt: (config: { description?: string }) => config.description ? `[system] ${config.description}` : "",
      }) as never,
    baseContextFor: (agentId) => ({ agentId, workingDirectory: "/tmp/x", config: {} }),
    sessionFactory: ({ ctx }) => {
      ctxs.push(ctx);
      return {
        on: () => {},
        get currentSessionId() {
          return null;
        },
        async start() {},
        send() {
          return { ok: true };
        },
        async stop() {},
      };
    },
    tickIntervalMs: 10_000,
  });
  return { mgr, ctxs };
}

describe("agent profile from server-downlinked RuntimeConfig", () => {
  it("calls driver.buildSystemPrompt to assemble the standing prompt", () => {
    const { mgr, ctxs } = managerCapturingCtx();
    mgr.register("agent_1", {
      runtimeConfig: makeRuntimeConfig({
        runtime: "mock",
        agentName: "Cindy",
        instruction: "You are the onboarding assistant.",
      }),
    });
    mgr.deliver("agent_1", { seq: 1, text: "hello" });

    expect(ctxs).toHaveLength(1);
    // instruction flows to config.description → driver.buildSystemPrompt wraps it
    expect(ctxs[0].standingPrompt).toBe("[system] You are the onboarding assistant.");
    expect(ctxs[0].config.description).toBe("You are the onboarding assistant.");
    expect(ctxs[0].config.runtimeConfig?.instruction).toBe("You are the onboarding assistant.");
  });

  it("returns empty standingPrompt when driver.buildSystemPrompt produces nothing", () => {
    const { mgr, ctxs } = managerCapturingCtx();
    mgr.register("agent_2", { runtimeConfig: makeRuntimeConfig({ runtime: "mock", agentName: "Bot" }) });
    mgr.deliver("agent_2", { seq: 1, text: "hi" });
    expect(ctxs[0].standingPrompt).toBe("[system] Bot");
    expect(ctxs[0].config.description).toBe("Bot");
  });
});
