import { describe, expect, it, vi } from "vitest";
import { isGuide, validBlogTags } from "./guides";
import { readBlogMetadata } from "./validate-assets";
import { validateMetadata } from "./posts/validate-metadata";

const post = { slug: "example", title: "Example", date: "2026-10-12", author: "Alook", excerpt: "Example", readingTime: "5 min read" };

describe("Guides metadata", () => {
  it("keeps legacy/other tags in the main Blog and recognizes the explicit tag", () => {
    expect(isGuide({})).toBe(false);
    expect(isGuide({ tags: ["coding"] })).toBe(false);
    expect(isGuide({ tags: ["coding", "guides"] })).toBe(true);
    expect(validBlogTags(undefined)).toBe(true);
    expect(validBlogTags([])).toBe(true);
  });
  it.each([null, "guides", ["Guides"], [""], [1], ["guides", "guides"]])("rejects invalid runtime tags %j", (tags) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(validateMetadata({ ...post, tags }, "example.mdx")).toBe(false);
    warn.mockRestore();
  });
  it("reads literal tags including comments, single quotes and trailing commas", () => {
    const source = `export const metadata = { ${Object.entries(post).map(([k,v]) => `${k}: ${JSON.stringify(v)}`).join(",")}, tags: [/* category */ 'coding', "guides",], };`;
    const result = readBlogMetadata(source, "example");
    expect(result.errors).toEqual([]);
    expect(result.metadata.tags).toEqual(["coding", "guides"]);
    expect(validateMetadata({ ...post, tags: result.metadata.tags }, "example.mdx")).toBe(true);
  });
  it.each(['"guides"', '["guides", "guides"]', '["guides", variable]', 'getTags()', '["Guides"]'])("rejects nonliteral or invalid source tags %s", (value) => {
    expect(readBlogMetadata(`export const metadata = { tags: ${value} }`, "example").errors.join()).toContain("tags must be");
  });
});
