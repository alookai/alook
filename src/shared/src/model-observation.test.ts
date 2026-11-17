import { describe, expect, it } from "vitest";
import { AgentModelMessageSchema } from "./model-observation";

const frame = { type: "agent_model", agentId: "bot", backendId: "codex", sessionInstanceId: "epoch", model: "auto", source: "session", observedAt: "2026-11-17T02:00:00.000Z" };
describe("native model report wire boundary", () => {
  it("preserves unknown selectors and rejects unsupported evidence, unbounded metadata and invalid dates", () => {
    expect(AgentModelMessageSchema.parse(frame).model).toBe("auto");
    for (const invalid of [{ source: "aggregate" }, { source: "requested" }, { model: "bad\nmodel" }, { model: "x".repeat(257) }, { responseId: "x".repeat(257) }, { observedAt: "yesterday" }]) {
      expect(AgentModelMessageSchema.safeParse({ ...frame, ...invalid }).success).toBe(false);
    }
  });
});
