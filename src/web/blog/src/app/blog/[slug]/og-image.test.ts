import { describe, expect, it } from "vitest";
import { getBlogOgImage } from "./og-image";

describe("getBlogOgImage", () => {
  it("preserves the existing article hero URL", () => {
    expect(
      getBlogOgImage({
        slug: "existing-hero",
        image: "/blog/existing-hero/hero.webp",
      }),
    ).toBe("/blog/existing-hero/hero.webp");
  });

  it("uses a route-owned fallback instead of accepting title input", () => {
    expect(getBlogOgImage({ slug: "missing hero", image: undefined })).toBe(
      "/og/blog/missing%20hero",
    );
  });
});
