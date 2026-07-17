import { describe, it, expect } from "vitest";
import { parseInviteToken } from "./invite-link";

describe("parseInviteToken", () => {
  it("extracts the token from a full URL with an origin", () => {
    expect(parseInviteToken("https://alook.dev/c/invite/AbC123XyZ0")).toBe("AbC123XyZ0");
  });

  it("extracts the token from a path-only URL (no origin)", () => {
    expect(parseInviteToken("/c/invite/AbC123XyZ0")).toBe("AbC123XyZ0");
  });

  it("extracts the token from a bare token", () => {
    expect(parseInviteToken("AbC123XyZ0")).toBe("AbC123XyZ0");
  });

  it("returns null for garbage input", () => {
    expect(parseInviteToken("not an invite at all")).toBeNull();
    expect(parseInviteToken("")).toBeNull();
    expect(parseInviteToken("   ")).toBeNull();
  });

  it("rejects tokens outside the [A-Za-z0-9_-]{6,64} charset", () => {
    expect(parseInviteToken("short")).toBeNull(); // 5 chars, below min
    expect(parseInviteToken("has spaces here")).toBeNull();
    expect(parseInviteToken("a".repeat(65))).toBeNull(); // above max
  });

  it("trims surrounding whitespace before validating a bare token", () => {
    expect(parseInviteToken("  AbC123XyZ0  ")).toBe("AbC123XyZ0");
  });
});
