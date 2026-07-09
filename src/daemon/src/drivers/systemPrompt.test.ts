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
 * These tests intentionally do NOT pin down exact prose/headings — that
 * content changes often and asserting on its literal wording turns every
 * copy edit into a test-fixing chore with no real regression protection.
 * Instead we test the actual input → output *contract*: what varies based
 * on `config`/`opts`, and what doesn't.
 */
describe("buildCliSystemPrompt", () => {
  it("returns non-empty content for both lifecycle kinds", () => {
    expect(buildCliSystemPrompt(baseConfig, { lifecycleKind: "persistent" }).length).toBeGreaterThan(0);
    expect(buildCliSystemPrompt(baseConfig, { lifecycleKind: "per_turn" }).length).toBeGreaterThan(0);
  });

  it("produces different content for persistent vs per_turn lifecycles", () => {
    const persistent = buildCliSystemPrompt(baseConfig, { lifecycleKind: "persistent" });
    const perTurn = buildCliSystemPrompt(baseConfig, { lifecycleKind: "per_turn" });
    expect(persistent).not.toBe(perTurn);
  });

  it("injects agentName and agentHandle into the prompt only when set", () => {
    const withIdentity = buildCliSystemPrompt(
      { ...baseConfig, agentName: "Nova", agentHandle: "nova" },
      { lifecycleKind: "persistent" },
    );
    expect(withIdentity).toContain("Nova");
    expect(withIdentity).toContain("nova");

    const without = buildCliSystemPrompt(baseConfig, { lifecycleKind: "persistent" });
    expect(without).not.toContain("Nova");
  });

  it("includes a Role section with config.description's exact text only when it's set", () => {
    const withRole = buildCliSystemPrompt(
      { ...baseConfig, description: "You are the onboarding assistant." },
      { lifecycleKind: "persistent" },
    );
    expect(withRole).toContain("You are the onboarding assistant.");
    expect(withRole).toContain("## Role");

    const withoutRole = buildCliSystemPrompt(baseConfig, { lifecycleKind: "persistent" });
    expect(withoutRole).not.toContain("You are the onboarding assistant.");
    expect(withoutRole).not.toContain("## Role");
  });

  it("never parameterizes the CLI/product identity away (Alook is the product, not a configurable host)", () => {
    const prompt = buildCliSystemPrompt(baseConfig, { lifecycleKind: "persistent" });
    expect(prompt).toContain("alook");
    expect(prompt).toContain("Alook");
  });
});
