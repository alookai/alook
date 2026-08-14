import { describe, expect, it } from "vitest";
import { CommunityAgentUpdateProfileRequestSchema } from "../../src/schemas";
import { MAX_PROFILE_ABOUT_LENGTH, MAX_SERVER_ICON_SIZE_BYTES } from "../../src/constants/community";

describe("CommunityAgentUpdateProfileRequestSchema", () => {
  it("requires at least one update and accepts an empty bio clear", () => {
    expect(CommunityAgentUpdateProfileRequestSchema.safeParse({}).success).toBe(false);
    expect(CommunityAgentUpdateProfileRequestSchema.safeParse({ bio: "" }).success).toBe(true);
  });

  it("enforces the public bio limit", () => {
    expect(CommunityAgentUpdateProfileRequestSchema.safeParse({
      bio: "x".repeat(MAX_PROFILE_ABOUT_LENGTH + 1),
    }).success).toBe(false);
  });

  it("accepts supported non-empty avatar bytes and rejects empty, unsupported, and oversize data", () => {
    const base = { filename: "avatar.png", contentType: "image/png" };
    expect(CommunityAgentUpdateProfileRequestSchema.safeParse({
      avatar: { ...base, data: new Uint8Array([1]) },
    }).success).toBe(true);
    expect(CommunityAgentUpdateProfileRequestSchema.safeParse({
      avatar: { ...base, data: new Uint8Array() },
    }).success).toBe(false);
    expect(CommunityAgentUpdateProfileRequestSchema.safeParse({
      avatar: { ...base, contentType: "image/svg+xml", data: new Uint8Array([1]) },
    }).success).toBe(false);
    expect(CommunityAgentUpdateProfileRequestSchema.safeParse({
      avatar: { ...base, data: new Uint8Array(MAX_SERVER_ICON_SIZE_BYTES + 1) },
    }).success).toBe(false);
  });
});
