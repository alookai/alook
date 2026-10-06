import { describe, expect, it } from "vitest";
import { isSafeRedirectPath, safeRedirectPath } from "./safe-redirect";

describe("safe redirect paths", () => {
  it.each([
    "/c/me",
    "/c/me/machines?tab=active",
    "/sign-in?redirect=%2Fc%2Fme",
    "/search?q=100%25",
    "/w",
    "/%77/sample/home?token=private",
    "/w/sample/home?token=private",
    "/workspaces",
    "/studio/new?template=a&workspace_id=private",
    "/invite/old-token",
  ])("accepts a local path: %s", (path) => {
    expect(isSafeRedirectPath(path)).toBe(true);
    expect(safeRedirectPath(path)).toBe(path);
  });

  it.each([
    "https://evil.example/c",
    "//evil.example/c",
    "/\\evil.example/c",
    "/%5Cevil.example/c",
    "/%2Fevil.example/c",
    "/%252Fevil.example/c",
    "/%255Cevil.example/c",
    "/c/me#secret",
    "/c/\nme",
    "/c/%0ame",
    "/" + "a".repeat(2048),
    "%",
  ])("rejects an unsafe path: %s", (path) => {
    expect(isSafeRedirectPath(path)).toBe(false);
    expect(safeRedirectPath(path)).toBe("/c/me");
  });

  it("retains the default and explicit fallback for missing return paths", () => {
    expect(safeRedirectPath(null)).toBe("/c/me");
    expect(safeRedirectPath(undefined, "/c/me/machines")).toBe("/c/me/machines");
  });
});
