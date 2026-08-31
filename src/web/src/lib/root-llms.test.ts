import { describe, expect, it } from "vitest";
import { buildRootLlmsTxt } from "./root-llms";
import type { BlogDiscoveryManifestV1 } from "./blog-discovery-manifest";

const sampleManifest: BlogDiscoveryManifestV1 = {
  version: 1,
  posts: [{
    slug: "why-we-built-alook",
    title: "Why We Built Alook",
    date: "2026-05-15",
    author: "Gus",
    excerpt: "Human excerpt for the post.",
    agentSummary: "Read when you want the origin story of Alook coordination.",
  },
  {
    slug: "ai-agent-team",
    title: "How to Build an AI Agent Team",
    date: "2026-06-08",
    author: "Alook Team",
    excerpt: "Fallback excerpt when agentSummary is missing.",
  }],
};

describe("buildRootLlmsTxt", () => {
  it("includes required sections and product facts", () => {
    const text = buildRootLlmsTxt(sampleManifest);

    expect(text.startsWith("# Alook\n")).toBe(true);
    expect(text).toContain("> Share your agents with people you trust.");
    expect(text).toContain("human-AI collaboration in shared rooms");
    expect(text).toContain("Humans and AI agents work together");
    expect(text).toContain("imagine Discord, with local agents in the room");
    expect(text).not.toContain("email addresses");
    expect(text).not.toContain(
      "Connect your own agents and run them as one coordinated team."
    );
    expect(text).toContain("## Key pages");
    expect(text).toContain("## Blog posts");
    expect(text).toContain("## Machine-readable surfaces");
    expect(text).toContain("## How Alook fits");
    expect(text).toContain("## Contact");
    expect(text).toContain(
      "Claude Code, Codex, Cursor, OpenCode, and Pi"
    );
    expect(text).toContain("https://github.com/alookai/alook");
    expect(text).toContain("https://alook.ai/llms.txt");
  });

  it("lists posts with absolute blog URLs, author, and date", () => {
    const text = buildRootLlmsTxt(sampleManifest);

    expect(text).toContain(
      "[Why We Built Alook](https://alook.ai/blog/why-we-built-alook)"
    );
    expect(text).toContain("Gus, published May 15, 2026");
    expect(text).toContain(
      "[How to Build an AI Agent Team](https://alook.ai/blog/ai-agent-team)"
    );
    expect(text).toContain("Alook Team, published June 8, 2026");
  });

  it("prefers agentSummary over excerpt", () => {
    const text = buildRootLlmsTxt(sampleManifest);

    expect(text).toContain(
      "Read when you want the origin story of Alook coordination."
    );
    expect(text).not.toContain("Human excerpt for the post.");
    expect(text).toContain("Fallback excerpt when agentSummary is missing.");
  });

  it("allows a custom site URL", () => {
    const text = buildRootLlmsTxt(sampleManifest, "http://localhost:3000");

    expect(text).toContain(
      "[Why We Built Alook](http://localhost:3000/blog/why-we-built-alook)"
    );
    expect(text).toContain("http://localhost:3000/llms.txt");
  });

  it("handles an empty post list", () => {
    const text = buildRootLlmsTxt({ version: 1, posts: [] });

    expect(text).toContain("- No published posts yet.");
    expect(text).toContain("## Blog posts");
  });

  it("omits Blog surfaces for the explicit self-host mode", () => {
    const text = buildRootLlmsTxt(null);

    expect(text).not.toContain("## Blog posts");
    expect(text).not.toContain("https://alook.ai/blog");
    expect(text).toContain("https://alook.ai/llms.txt");
  });
});
