import { describe, it, expect } from "vitest";
import { generateWorkspaceSlug } from "../../src/utils/slug";

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
});
