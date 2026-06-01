import { describe, it, expect } from "vitest";
import { UpsertAgentLinkRequestSchema } from "../../src/schemas";

// TC11
describe("UpsertAgentLinkRequestSchema", () => {
  it("accepts a valid target_agent_id + instruction", () => {
    const result = UpsertAgentLinkRequestSchema.parse({
      target_agent_id: "ag_b",
      instruction: "DELEGATE when needed",
    });
    expect(result.target_agent_id).toBe("ag_b");
    expect(result.instruction).toBe("DELEGATE when needed");
  });

  it("accepts an empty instruction string", () => {
    const result = UpsertAgentLinkRequestSchema.parse({
      target_agent_id: "ag_b",
      instruction: "",
    });
    expect(result.instruction).toBe("");
  });

  it("rejects missing target_agent_id", () => {
    expect(() => UpsertAgentLinkRequestSchema.parse({ instruction: "x" })).toThrow();
  });

  it("rejects empty target_agent_id", () => {
    expect(() =>
      UpsertAgentLinkRequestSchema.parse({ target_agent_id: "", instruction: "x" }),
    ).toThrow();
  });

  it("rejects non-string instruction", () => {
    expect(() =>
      UpsertAgentLinkRequestSchema.parse({ target_agent_id: "ag_b", instruction: 123 }),
    ).toThrow();
  });

  it("rejects missing instruction", () => {
    expect(() =>
      UpsertAgentLinkRequestSchema.parse({ target_agent_id: "ag_b" }),
    ).toThrow();
  });
});
