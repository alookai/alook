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
    // Discriminator deliberately avoids "4821" — the messaging section's own
    // illustrative example (`@gustavo#4821`) is fixed doc prose, unrelated to
    // `config.agentHandle`, and would collide with a `not.toContain` check
    // below if reused here.
    const withIdentity = buildCliSystemPrompt(
      { ...baseConfig, agentName: "Nova", agentHandle: "@nova#7392" },
      { lifecycleKind: "persistent" },
    );
    expect(withIdentity).toContain("Nova");
    // Assert on the contract (config.agentHandle's exact value round-trips
    // verbatim), not on the surrounding prose — see this file's philosophy
    // note above.
    expect(withIdentity).toContain("@nova#7392");

    const without = buildCliSystemPrompt(baseConfig, { lifecycleKind: "persistent" });
    expect(without).not.toContain("Nova");
    expect(without).not.toContain("#7392");
  });

  it("includes a Role subsection (nested under Identity) with config.description's exact text only when it's set", () => {
    const withRole = buildCliSystemPrompt(
      { ...baseConfig, description: "You are the onboarding assistant." },
      { lifecycleKind: "persistent" },
    );
    expect(withRole).toContain("You are the onboarding assistant.");
    expect(withRole).toContain("### Role");
    expect(withRole).toContain("## Identity");

    const withoutRole = buildCliSystemPrompt(baseConfig, { lifecycleKind: "persistent" });
    expect(withoutRole).not.toContain("You are the onboarding assistant.");
    expect(withoutRole).not.toContain("### Role");
  });

  it("never parameterizes the CLI/product identity away (Alook is the product, not a configurable host)", () => {
    const prompt = buildCliSystemPrompt(baseConfig, { lifecycleKind: "persistent" });
    expect(prompt).toContain("alook");
    expect(prompt).toContain("Alook");
  });

  it("lists the three server commands under ### Servers", () => {
    const prompt = buildCliSystemPrompt(baseConfig, { lifecycleKind: "persistent" });
    expect(prompt).toContain("### Servers");
    expect(prompt).toContain("server list");
    expect(prompt).toContain("server member");
    expect(prompt).toContain("server join");
  });

  it("instructs the agent to act on /community/invite/ links", () => {
    const prompt = buildCliSystemPrompt(baseConfig, { lifecycleKind: "persistent" });
    expect(prompt).toContain("/community/invite/");
  });

  it("tells the agent that channel refs also render as clickable links when written inline in message text", () => {
    // Contract check, not prose pinning (see file-level comment above): both
    // lifecycle kinds share `messagingSection()`, so a single stable phrase
    // covering "refs work inline, not just as --target" is enough — no need
    // to duplicate per lifecycle kind.
    const prompt = buildCliSystemPrompt(baseConfig, { lifecycleKind: "persistent" });
    expect(prompt).toContain("also work inline");
    expect(prompt).toContain("clickable channel");
  });

  it("lists the two channel commands under ### Channels, positioned after ### Servers", () => {
    const prompt = buildCliSystemPrompt(baseConfig, { lifecycleKind: "persistent" });
    expect(prompt).toContain("### Channels");
    expect(prompt).toContain("channel list");
    expect(prompt).toContain("channel history");
    expect(prompt.indexOf("### Servers")).toBeLessThan(prompt.indexOf("### Channels"));
  });

  it("includes a ## Channels section (after ## Servers) explaining {ref,name,type}", () => {
    const prompt = buildCliSystemPrompt(baseConfig, { lifecycleKind: "persistent" });
    expect(prompt).toContain("## Channels");
    expect(prompt.indexOf("## Servers")).toBeLessThan(prompt.indexOf("## Channels"));
    expect(prompt).toContain("ref, name, type");
  });

  it("no longer references channel subscribe anywhere in the prompt", () => {
    for (const lifecycleKind of ["persistent", "per_turn"] as const) {
      const prompt = buildCliSystemPrompt(baseConfig, { lifecycleKind });
      expect(prompt).not.toContain("channel subscribe");
      expect(prompt).not.toContain("wake-notification level");
    }
  });
});
