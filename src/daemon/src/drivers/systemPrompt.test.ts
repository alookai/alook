import { describe, it, expect } from "vitest";
import { buildCliSystemPrompt } from "./systemPrompt";
import type { HostLaunchConfig as LaunchConfig } from "../manager/hostContext.js";

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
 *   `LaunchConfig` must round-trip verbatim into the output, and their
 *   absence must NOT leak into the output.
 * - DO NOT ADD tests that assert on specific prompt content (section headings,
 *   command names, feature strings, tone words). If you find yourself writing
 *   `expect(prompt).toContain("some english phrase")` for a phrase that isn't
 *   a value the caller passed in, stop — that test does not belong here.
 */
describe("buildCliSystemPrompt", () => {
  it("returns non-empty content", () => {
    expect(buildCliSystemPrompt(baseConfig).length).toBeGreaterThan(0);
  });

  it("round-trips agentName and agentHandle verbatim, and omits them when absent", () => {
    const withIdentity = buildCliSystemPrompt({ ...baseConfig, agentName: "Nova", agentHandle: "@nova#7392" });
    expect(withIdentity).toContain("Nova");
    expect(withIdentity).toContain("@nova#7392");

    const without = buildCliSystemPrompt(baseConfig);
    expect(without).not.toContain("Nova");
    expect(without).not.toContain("#7392");
  });

  it("round-trips ownerHandle verbatim, and omits it when absent", () => {
    const withOwner = buildCliSystemPrompt({ ...baseConfig, ownerHandle: "@gustavo#5150" });
    expect(withOwner).toContain("@gustavo#5150");

    const without = buildCliSystemPrompt(baseConfig);
    expect(without).not.toContain("#5150");
  });

  it("round-trips config.description verbatim, and omits it when absent", () => {
    const withRole = buildCliSystemPrompt({ ...baseConfig, description: "You are the onboarding assistant." });
    expect(withRole).toContain("You are the onboarding assistant.");

    const withoutRole = buildCliSystemPrompt(baseConfig);
    expect(withoutRole).not.toContain("You are the onboarding assistant.");
  });

});
