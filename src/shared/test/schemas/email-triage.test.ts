import { describe, expect, it } from "vitest";
import { EmailTriageResultSchema } from "../../src/schemas";

describe("EmailTriageResultSchema", () => {
  it("accepts untrust decision", () => {
    const result = EmailTriageResultSchema.parse({ decision: "untrust" });
    expect(result).toEqual({ decision: "untrust" });
  });

  it("accepts draft reply with subject and htmlBody", () => {
    const result = EmailTriageResultSchema.parse({
      decision: "draft_reply",
      draft: { subject: "Re: Hello", htmlBody: "<p>Hello</p>" },
    });

    expect(result).toEqual({
      decision: "draft_reply",
      draft: { subject: "Re: Hello", htmlBody: "<p>Hello</p>" },
    });
  });

  it("rejects empty draft subject and body", () => {
    expect(() => EmailTriageResultSchema.parse({
      decision: "draft_reply",
      draft: { subject: "", htmlBody: "<p>Hello</p>" },
    })).toThrow();
    expect(() => EmailTriageResultSchema.parse({
      decision: "draft_reply",
      draft: { subject: "Re: Hello", htmlBody: "" },
    })).toThrow();
  });
});
