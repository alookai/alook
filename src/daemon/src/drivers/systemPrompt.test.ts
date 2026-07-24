import { describe, it, expect } from "vitest";
import { buildCliSystemPrompt } from "./systemPrompt";
import type { LaunchConfig } from "../types";

const baseConfig: LaunchConfig = {
  runtimeContext: {
    agentId: "agent_7",
    serverId: "srv_3",
    computerId: "comp_1",
    computerName: "Box",
    hostname: "box.local",
    os: "darwin",
    daemonVersion: "0.61.1",
    workspacePath: "/ws",
  },
};

/**
 * Rules for this file:
 * - The system prompt's prose (headings, section titles, feature keywords,
 *   phrasing) changes constantly. Asserting on that content is worthless
 *   regression protection and turns every copy edit into a test-fixing chore.
 * - Only test the INPUT → OUTPUT contract: values that come in via
 *   `LaunchConfig` / `SystemPromptOpts` must round-trip verbatim into the
 *   output, and their absence must NOT leak into the output.
 * - DO NOT ADD tests that assert on specific prompt content (section headings,
 *   command names, feature strings, tone words). If you find yourself writing
 *   `expect(prompt).toContain("some english phrase")` for a phrase that isn't
 *   a value the caller passed in, stop — that test does not belong here.
 */
describe("buildCliSystemPrompt", () => {
  it("returns non-empty content for both lifecycle kinds", () => {
    expect(buildCliSystemPrompt(baseConfig, { lifecycleKind: "persistent" }).length).toBeGreaterThan(0);
    expect(buildCliSystemPrompt(baseConfig, { lifecycleKind: "per_turn" }).length).toBeGreaterThan(0);
  });

  it("produces the same content for persistent vs per_turn lifecycles (messageNotificationSection removed)", () => {
    const persistent = buildCliSystemPrompt(baseConfig, { lifecycleKind: "persistent" });
    const perTurn = buildCliSystemPrompt(baseConfig, { lifecycleKind: "per_turn" });
    expect(persistent).toBe(perTurn);
  });

  it("round-trips agentName and agentHandle verbatim, and omits them when absent", () => {
    const withIdentity = buildCliSystemPrompt(
      { ...baseConfig, agentName: "Nova", agentHandle: "@nova#7392" },
      { lifecycleKind: "persistent" },
    );
    expect(withIdentity).toContain("Nova");
    expect(withIdentity).toContain("@nova#7392");

    const without = buildCliSystemPrompt(baseConfig, { lifecycleKind: "persistent" });
    expect(without).not.toContain("Nova");
    expect(without).not.toContain("#7392");
  });

  it("round-trips ownerHandle verbatim, and omits it when absent", () => {
    const withOwner = buildCliSystemPrompt(
      { ...baseConfig, ownerHandle: "@gustavo#5150" },
      { lifecycleKind: "persistent" },
    );
    expect(withOwner).toContain("@gustavo#5150");

    const without = buildCliSystemPrompt(baseConfig, { lifecycleKind: "persistent" });
    expect(without).not.toContain("#5150");
  });

  it("round-trips config.description verbatim, and omits it when absent", () => {
    const withRole = buildCliSystemPrompt(
      { ...baseConfig, description: "You are the onboarding assistant." },
      { lifecycleKind: "persistent" },
    );
    expect(withRole).toContain("You are the onboarding assistant.");

    const withoutRole = buildCliSystemPrompt(baseConfig, { lifecycleKind: "persistent" });
    expect(withoutRole).not.toContain("You are the onboarding assistant.");
  });
});
