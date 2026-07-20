import { describe, it, expect } from "vitest";
import { validateCommunityName, sanitizeCommunityName } from "../../src/lib/community-name";

describe("validateCommunityName", () => {
  it("accepts a plain name", () => {
    expect(validateCommunityName("Alice")).toEqual({ ok: true });
  });

  it("accepts spaces, unicode, hyphens, underscores", () => {
    expect(validateCommunityName("John Doe")).toEqual({ ok: true });
    expect(validateCommunityName("李四")).toEqual({ ok: true });
    expect(validateCommunityName("José")).toEqual({ ok: true });
    expect(validateCommunityName("Ünal")).toEqual({ ok: true });
    expect(validateCommunityName("jean-luc_picard")).toEqual({ ok: true });
  });

  it("rejects a name containing #", () => {
    expect(validateCommunityName("Ann#1234").ok).toBe(false);
    expect(validateCommunityName("a#b").ok).toBe(false);
  });

  it("rejects a name containing @", () => {
    expect(validateCommunityName("bad@name").ok).toBe(false);
  });

  it("rejects a name containing a newline or other control char", () => {
    expect(validateCommunityName("line\nbreak").ok).toBe(false);
    expect(validateCommunityName("tab\there").ok).toBe(false);
    expect(validateCommunityName("cr\rhere").ok).toBe(false);
  });

  it("rejects empty / whitespace-only names", () => {
    expect(validateCommunityName("").ok).toBe(false);
    expect(validateCommunityName("   ").ok).toBe(false);
  });

  it("rejects names longer than 100 chars (after trim)", () => {
    expect(validateCommunityName("a".repeat(101)).ok).toBe(false);
    expect(validateCommunityName("a".repeat(100)).ok).toBe(true);
  });

  it("carries a human-readable reason", () => {
    const res = validateCommunityName("Ann#1234");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/#/);
  });
});

describe("sanitizeCommunityName", () => {
  it("strips # and @ and collapses whitespace", () => {
    expect(sanitizeCommunityName("Ann#1234")).toBe("Ann1234");
    expect(sanitizeCommunityName("bad@name")).toBe("badname");
    expect(sanitizeCommunityName("a\nb\tc")).toBe("a b c");
  });

  it("keeps a clean name unchanged", () => {
    expect(sanitizeCommunityName("John Doe")).toBe("John Doe");
    expect(sanitizeCommunityName("李四")).toBe("李四");
  });

  it("clamps to 100 chars", () => {
    expect(sanitizeCommunityName("a".repeat(200)).length).toBe(100);
  });

  it("falls back to a placeholder when fully stripped", () => {
    expect(sanitizeCommunityName("###")).toBe("user");
    expect(sanitizeCommunityName("")).toBe("user");
  });
});
