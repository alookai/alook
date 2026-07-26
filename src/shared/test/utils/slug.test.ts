import { describe, it, expect } from "vitest";
import { generateWorkspaceSlug, sanitizeSlug } from "../../src/utils/slug";

describe("generateWorkspaceSlug", () => {
  it("starts with 'company-' prefix", () => {
    const slug = generateWorkspaceSlug();
    expect(slug.startsWith("company-")).toBe(true);
  });

  it("has correct total length (company- prefix + 8 char nanoid)", () => {
    const slug = generateWorkspaceSlug();
    expect(slug.length).toBe("company-".length + 8);
  });

  it("generates unique slugs", () => {
    const slugs = new Set(Array.from({ length: 100 }, () => generateWorkspaceSlug()));
    expect(slugs.size).toBe(100);
  });

  it("emits only lowercase alnum after the prefix (no uppercase or '_')", () => {
    for (let i = 0; i < 200; i++) {
      expect(generateWorkspaceSlug()).toMatch(/^company-[a-z0-9]{8}$/);
    }
  });
});

describe("sanitizeSlug", () => {
  it("lowercases and hyphenates spaces", () => {
    expect(sanitizeSlug("My Company")).toBe("my-company");
  });

  it("trims and collapses internal whitespace", () => {
    expect(sanitizeSlug("  hello   world  ")).toBe("hello-world");
  });

  it("turns URL-reserved chars into separators", () => {
    expect(sanitizeSlug("a/b#c?d")).toBe("a-b-c-d");
  });

  it("collapses symbol runs to a single hyphen", () => {
    expect(sanitizeSlug("Foo___Bar!!!Baz")).toBe("foo-bar-baz");
  });

  it("returns empty for non-ASCII input", () => {
    expect(sanitizeSlug("总部 🎉")).toBe("");
  });

  it("returns empty for all-separator or empty input", () => {
    expect(sanitizeSlug("!!!")).toBe("");
    expect(sanitizeSlug("   ")).toBe("");
    expect(sanitizeSlug("")).toBe("");
  });

  it("leaves an already-clean slug unchanged", () => {
    expect(sanitizeSlug("already-clean-slug")).toBe("already-clean-slug");
  });

  it("truncates to at most 60 chars with no trailing hyphen", () => {
    const out = sanitizeSlug("a".repeat(70));
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out.endsWith("-")).toBe(false);
  });

  it("does not leave a trailing hyphen when truncation lands on a separator", () => {
    const out = sanitizeSlug("a".repeat(59) + " tail");
    expect(out.endsWith("-")).toBe(false);
    expect(out.length).toBeLessThanOrEqual(60);
  });
});
