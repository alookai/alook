import { describe, it, expect } from "vitest";
import { CommunityAgentSendRequestSchema } from "../../src/schemas";

describe("CommunityAgentSendRequestSchema — replyToSeq", () => {
  it("accepts a valid positive replyToSeq", () => {
    const parsed = CommunityAgentSendRequestSchema.safeParse({
      channel: "/studio/general",
      content: { text: "on it" },
      replyToSeq: 37,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.replyToSeq).toBe(37);
  });

  it("is optional — a send with no replyToSeq still parses", () => {
    const parsed = CommunityAgentSendRequestSchema.safeParse({
      channel: "/studio/general",
      content: { text: "hi" },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.replyToSeq).toBeUndefined();
  });

  it("rejects replyToSeq = 0 (min(1) — 0 is the legacy sentinel, never a real message)", () => {
    const parsed = CommunityAgentSendRequestSchema.safeParse({
      channel: "/studio/general",
      content: { text: "hi" },
      replyToSeq: 0,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a negative replyToSeq", () => {
    const parsed = CommunityAgentSendRequestSchema.safeParse({
      channel: "/studio/general",
      content: { text: "hi" },
      replyToSeq: -3,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a non-integer replyToSeq", () => {
    const parsed = CommunityAgentSendRequestSchema.safeParse({
      channel: "/studio/general",
      content: { text: "hi" },
      replyToSeq: 3.5,
    });
    expect(parsed.success).toBe(false);
  });
});
