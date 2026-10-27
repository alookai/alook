import { describe, expect, it } from "vitest";
import { getStepGuide, stepGuides } from "./step-guides";

describe("step guide registry", () => {
  it("resolves only registered routes and uses unique slugs", () => {
    expect(getStepGuide("codex-and-claude-code")?.title).toContain("Codex and Claude Code");
    expect(getStepGuide("missing")).toBeUndefined();
    expect(new Set(stepGuides.map(({ slug }) => slug)).size).toBe(stepGuides.length);
  });
});
