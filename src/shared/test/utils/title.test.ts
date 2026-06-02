import { describe, it, expect } from "vitest";
import { truncateTitle } from "../../src/utils/title";

describe("truncateTitle", () => {
  it("collapses runs of whitespace into single spaces", () => {
    expect(truncateTitle("hello   \n\t  world")).toBe("hello world");
  });

  it("trims leading and trailing whitespace", () => {
    expect(truncateTitle("   padded title   ")).toBe("padded title");
  });

  it("returns the text unchanged when at or under the cap", () => {
    const exact = "a".repeat(50);
    expect(truncateTitle(exact)).toBe(exact);
    expect(truncateTitle("short")).toBe("short");
  });

  it("caps at a word boundary and appends an ellipsis", () => {
    // 60-char input, last space before the 50-char cut is after "boundary".
    const text =
      "the quick brown fox jumps over the lazy dog near a boundary marker";
    const out = truncateTitle(text);
    expect(out.endsWith("...")).toBe(true);
    expect(out).not.toContain("  ");
    // Cut on a space, never mid-word.
    expect(out.slice(0, -3).endsWith(" ")).toBe(false);
    expect(out.length).toBeLessThanOrEqual(53); // <=50 word-boundary cut + "..."
  });

  it("hard-cuts mid-word when there's no late-enough space (lastSpace <= 20)", () => {
    // One long token (no spaces) — lastSpace is -1, so it slices at maxLen.
    const text = "x".repeat(80);
    const out = truncateTitle(text);
    expect(out).toBe("x".repeat(50) + "...");
  });

  it("respects a custom maxLen", () => {
    expect(truncateTitle("hello world", 5)).toBe("hello...");
  });
});
