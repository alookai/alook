import { describe, expect, it } from "vitest";
import { getStepGuide, stepGuides, tutorialAgents } from "./step-guides";

describe("step guide registry", () => {
  it("registers the original and all six requested ordered pairs", () => {
    expect(stepGuides.map(guide => guide.agents)).toEqual([
      ["codex", "claude"], ["grok", "codex"], ["grok", "claude"],
      ["opencode", "codex"], ["opencode", "claude"], ["cursor", "codex"], ["cursor", "claude"],
    ]);
    for (const guide of stepGuides) {
      for (const runtime of guide.agents) expect(guide.description).toContain(tutorialAgents[runtime].name);
    }
    expect(new Set(stepGuides.map(guide => guide.connectLead)).size).toBe(7);
    expect(new Set(stepGuides.map(guide => guide.messageLead)).size).toBe(7);
  });
  it("resolves only registered routes and uses unique slugs", () => {
    expect(getStepGuide("codex-and-claude-code")?.title).toContain("Codex and Claude Code");
    expect(getStepGuide("missing")).toBeUndefined();
    expect(new Set(stepGuides.map(({ slug }) => slug)).size).toBe(stepGuides.length);
  });
});
