import { describe, expect, it } from "vitest";
import { getBlogSearchTitle } from "./metadata";

describe("getBlogSearchTitle", () => {
  it("uses a dedicated SEO title when provided", () => {
    expect(
      getBlogSearchTitle({
        title: "A longer on-page headline",
        seoTitle: "A concise search title",
      })
    ).toBe("A concise search title");
  });

  it("falls back to the visible headline", () => {
    expect(getBlogSearchTitle({ title: "The visible headline" })).toBe(
      "The visible headline"
    );
  });
});
