import { describe, expect, it } from "vitest";
import { extractBlogHeadings, getBlogHeadingsBySlug, slugifyHeading } from "./headings";

describe("blog headings extractor", () => {
  it("matches github-slugger style slugs", () => {
    expect(slugifyHeading("Why Claude Code + Codex?")).toBe("why-claude-code--codex");
    expect(slugifyHeading("Step 1: Connect a `daemon`")).toBe("step-1-connect-a-daemon");
    expect(slugifyHeading("What's Next — Ship It!")).toBe("whats-next--ship-it");
  });

  it("extracts H2 headings, ignores fenced code blocks, strips markdown, and deduplicates IDs", () => {
    const mdx = [
      "export const metadata = { title: 'Test' }",
      "",
      "## Overview",
      "Some text.",
      "",
      "```md",
      "## Not A Heading",
      "```",
      "",
      "### Subheading ignored",
      "",
      "## Run **Claude Code** with [Alook](https://alook.ai)",
      "",
      "## Overview",
      "",
      "## Overview",
    ].join("\n");

    expect(extractBlogHeadings(mdx)).toEqual([
      { id: "overview", text: "Overview" },
      { id: "run-claude-code-with-alook", text: "Run Claude Code with Alook" },
      { id: "overview-1", text: "Overview" },
      { id: "overview-2", text: "Overview" },
    ]);
  });

  it("reads headings from published MDX posts", () => {
    const headings = getBlogHeadingsBySlug("claude-code-and-codex-same-team");
    expect(headings.length).toBeGreaterThanOrEqual(4);
    expect(headings.every((h) => h.id.length > 0 && h.text.length > 0)).toBe(true);
    expect(getBlogHeadingsBySlug("non-existent-post-slug")).toEqual([]);
  });
});
