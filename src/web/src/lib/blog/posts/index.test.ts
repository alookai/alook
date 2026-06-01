import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", () => ({
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
}));

import { readdirSync, readFileSync } from "fs";
import { getAllPosts, getPostBySlug } from "./index";

const mockReaddirSync = vi.mocked(readdirSync);
const mockReadFileSync = vi.mocked(readFileSync);

function makeMdxContent(metadata: Record<string, unknown>): string {
  const entries = Object.entries(metadata)
    .map(([key, value]) => `  ${key}: ${JSON.stringify(value)}`)
    .join(",\n");
  return `export const metadata = {\n${entries},\n};\n\n# Hello World\n`;
}

const postA = {
  slug: "post-a",
  title: "Post A",
  date: "2026-05-01",
  author: "Alice",
  excerpt: "First post",
  readingTime: "3 min read",
};

const postB = {
  slug: "post-b",
  title: "Post B",
  date: "2026-06-01",
  author: "Bob",
  excerpt: "Second post",
  readingTime: "5 min read",
};

const draftPost = {
  slug: "draft-post",
  title: "Draft Post",
  date: "2026-06-02",
  author: "Charlie",
  excerpt: "Draft",
  readingTime: "2 min read",
  draft: true,
};

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("getAllPosts", () => {
  it("auto-discovers all mdx files and returns them sorted by date descending", async () => {
    mockReaddirSync.mockReturnValue(
      ["post-a.mdx", "post-b.mdx"] as unknown as ReturnType<
        typeof readdirSync
      >
    );
    mockReadFileSync.mockImplementation((filePath) => {
      const path = filePath.toString();
      if (path.includes("post-a.mdx")) return makeMdxContent(postA);
      if (path.includes("post-b.mdx")) return makeMdxContent(postB);
      return "";
    });

    const { getAllPosts: freshGetAllPosts } = await import("./index");
    const posts = freshGetAllPosts();

    expect(posts).toHaveLength(2);
    expect(posts[0].slug).toBe("post-b");
    expect(posts[1].slug).toBe("post-a");
  });

  it("excludes draft posts from results", async () => {
    mockReaddirSync.mockReturnValue(
      ["post-a.mdx", "draft-post.mdx"] as unknown as ReturnType<
        typeof readdirSync
      >
    );
    mockReadFileSync.mockImplementation((filePath) => {
      const path = filePath.toString();
      if (path.includes("post-a.mdx")) return makeMdxContent(postA);
      if (path.includes("draft-post.mdx")) return makeMdxContent(draftPost);
      return "";
    });

    const { getAllPosts: freshGetAllPosts } = await import("./index");
    const posts = freshGetAllPosts();

    expect(posts).toHaveLength(1);
    expect(posts[0].slug).toBe("post-a");
    expect(posts.find((p) => p.slug === "draft-post")).toBeUndefined();
  });

  it("ignores files without valid metadata export", async () => {
    mockReaddirSync.mockReturnValue(
      ["post-a.mdx", "invalid.mdx"] as unknown as ReturnType<
        typeof readdirSync
      >
    );
    mockReadFileSync.mockImplementation((filePath) => {
      const path = filePath.toString();
      if (path.includes("post-a.mdx")) return makeMdxContent(postA);
      if (path.includes("invalid.mdx")) return "# Just markdown, no metadata";
      return "";
    });

    const { getAllPosts: freshGetAllPosts } = await import("./index");
    const posts = freshGetAllPosts();

    expect(posts).toHaveLength(1);
    expect(posts[0].slug).toBe("post-a");
  });
});

describe("getPostBySlug", () => {
  it("returns the post matching the given slug", async () => {
    mockReaddirSync.mockReturnValue(
      ["post-a.mdx", "post-b.mdx"] as unknown as ReturnType<
        typeof readdirSync
      >
    );
    mockReadFileSync.mockImplementation((filePath) => {
      const path = filePath.toString();
      if (path.includes("post-a.mdx")) return makeMdxContent(postA);
      if (path.includes("post-b.mdx")) return makeMdxContent(postB);
      return "";
    });

    const { getPostBySlug: freshGetPostBySlug } = await import("./index");
    const post = freshGetPostBySlug("post-a");

    expect(post).toBeDefined();
    expect(post!.title).toBe("Post A");
  });

  it("returns undefined for a draft slug", async () => {
    mockReaddirSync.mockReturnValue(
      ["post-a.mdx", "draft-post.mdx"] as unknown as ReturnType<
        typeof readdirSync
      >
    );
    mockReadFileSync.mockImplementation((filePath) => {
      const path = filePath.toString();
      if (path.includes("post-a.mdx")) return makeMdxContent(postA);
      if (path.includes("draft-post.mdx")) return makeMdxContent(draftPost);
      return "";
    });

    const { getPostBySlug: freshGetPostBySlug } = await import("./index");
    const post = freshGetPostBySlug("draft-post");

    expect(post).toBeUndefined();
  });
});
