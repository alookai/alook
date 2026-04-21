import { describe, it, expect } from "vitest";
import { UpdateMemberRequestSchema } from "../../src/schemas";

describe("UpdateMemberRequestSchema", () => {
  it("accepts valid global_instruction", () => {
    const result = UpdateMemberRequestSchema.parse({ global_instruction: "speak chinese" });
    expect(result.global_instruction).toBe("speak chinese");
  });

  it("accepts empty string", () => {
    const result = UpdateMemberRequestSchema.parse({ global_instruction: "" });
    expect(result.global_instruction).toBe("");
  });

  it("rejects missing global_instruction", () => {
    expect(() => UpdateMemberRequestSchema.parse({})).toThrow();
  });

  it("rejects strings over 50000 chars", () => {
    expect(() =>
      UpdateMemberRequestSchema.parse({ global_instruction: "x".repeat(50001) })
    ).toThrow();
  });

  it("accepts strings at 50000 chars", () => {
    const result = UpdateMemberRequestSchema.parse({ global_instruction: "x".repeat(50000) });
    expect(result.global_instruction).toHaveLength(50000);
  });
});
