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

  // Exception to the "don't assert on prose" rule above: the ref-grammar
  // wording is a load-bearing contract, not incidental phrasing. `#N` refs now
  // address both threads AND forum posts, so the prompt must teach the child
  // channel as "thread or post" and must never leak the internal `forum_post`
  // storage literal (renamed to `post`). See plan D2c.
  it("teaches child channels as 'thread or post' and never leaks forum_post", () => {
    const prompt = buildCliSystemPrompt(baseConfig, { lifecycleKind: "persistent" });
    expect(prompt).toContain("child channel (thread or post)");
    expect(prompt).not.toContain("forum_post");
  });

  // Exception to the "don't assert on prose" rule: id addressing is a
  // load-bearing contract. The CLI addresses channels/DMs/messages by id
  // (`--channel`/`--dm`/`--message`), not by the old `/<server>/<channel>`
  // path refs — the prompt must teach the former and must not resurrect the
  // latter's ref table.
  it("teaches id addressing and never resurrects the /<server>/<channel> ref table", () => {
    const prompt = buildCliSystemPrompt(baseConfig);
    expect(prompt).toContain("--channel");
    expect(prompt).toContain("--dm");
    expect(prompt).not.toContain("/<server>/<channel>");
  });

  it("round-trips config.description verbatim, and omits it when absent", () => {
    const withRole = buildCliSystemPrompt({ ...baseConfig, description: "You are the onboarding assistant." });
    expect(withRole).toContain("You are the onboarding assistant.");

    const withoutRole = buildCliSystemPrompt(baseConfig);
    expect(withoutRole).not.toContain("You are the onboarding assistant.");
  });
});
