import { describe, expect, it } from "vitest";
import { AgentModelReportSchema } from "./model-observation";

const frame = { agentId: "bot", backendId: "codex", runtimeConfigRevision: 0, sessionInstanceId: "epoch", model: "auto", source: "session", observedAt: "2026-11-17T02:00:00.000Z" };
describe("native model report wire boundary", () => {
  it("preserves unknown selectors and rejects unsupported evidence, unbounded metadata and invalid dates", () => {
    expect(AgentModelReportSchema.parse(frame).model).toBe("auto");
    for (const invalid of [{ runtimeConfigRevision: undefined }, { runtimeConfigRevision: -1 }, { runtimeConfigRevision: 1.5 }, { source: "aggregate" }, { source: "requested" }, { model: "bad\nmodel" }, { model: "x".repeat(257) }, { responseId: "x".repeat(257) }, { observedAt: "yesterday" }]) {
      expect(AgentModelReportSchema.safeParse({ ...frame, ...invalid }).success).toBe(false);
    }
  });
});
