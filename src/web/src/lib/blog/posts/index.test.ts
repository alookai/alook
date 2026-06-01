import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BlogPost } from "../types";

vi.mock("fs", () => ({
  readdirSync: vi.fn(),
}));

vi.mock("./import-mdx", () => ({
  importMdxMetadata: vi.fn(),
}));

import { readdirSync } from "fs";
import { importMdxMetadata } from "./import-mdx";

const mockReaddirSync = vi.mocked(readdirSync);
const mockImportMdxMetadata = vi.mocked(importMdxMetadata);

const postA: BlogPost = {
  slug: "post-a",
  title: "Post A",
  date: "2026-05-01",
  author: "Alice",
  excerpt: "First post",
  readingTime: "3 min read",
};

const postB: BlogPost = {
  slug: "post-b",
  title: "Post B",
  date: "2026-06-01",
  author: "Bob",
  excerpt: "Second post",
  readingTime: "5 min read",
};

const draftPost: BlogPost = {
  slug: "draft-post",
  title: "Draft Post",
  date: "2026-06-02",
  author: "Charlie",
  excerpt: "Draft",
  readingTime: "2 min read",
  draft: true,
};

const incompletePost = {
  slug: "incomplete",
  title: "No Author",
} as unknown as BlogPost;

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
    mockImportMdxMetadata.mockImplementation(async (slug) => {
      if (slug === "post-a") return postA;
      if (slug === "post-b") return postB;
      return undefined;
    });

    const { getAllPosts } = await import("./index");
    const posts = await getAllPosts();

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
    mockImportMdxMetadata.mockImplementation(async (slug) => {
      if (slug === "post-a") return postA;
      if (slug === "draft-post") return draftPost;
      return undefined;
    });

    const { getAllPosts } = await import("./index");
    const posts = await getAllPosts();

    expect(posts).toHaveLength(1);
    expect(posts[0].slug).toBe("post-a");
    expect(posts.find((p) => p.slug === "draft-post")).toBeUndefined();
  });

  it("skips files without metadata export", async () => {
    mockReaddirSync.mockReturnValue(
      ["post-a.mdx", "no-metadata.mdx"] as unknown as ReturnType<
        typeof readdirSync
      >
    );
    mockImportMdxMetadata.mockImplementation(async (slug) => {
      if (slug === "post-a") return postA;
      return undefined;
    });

    const { getAllPosts } = await import("./index");
    const posts = await getAllPosts();

    expect(posts).toHaveLength(1);
    expect(posts[0].slug).toBe("post-a");
  });

  it("skips files with missing required fields and logs a warning", async () => {
    mockReaddirSync.mockReturnValue(
      ["post-a.mdx", "incomplete.mdx"] as unknown as ReturnType<
        typeof readdirSync
      >
    );
    mockImportMdxMetadata.mockImplementation(async (slug) => {
      if (slug === "post-a") return postA;
      if (slug === "incomplete") return incompletePost;
      return undefined;
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { getAllPosts } = await import("./index");
    const posts = await getAllPosts();

    expect(posts).toHaveLength(1);
    expect(posts[0].slug).toBe("post-a");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("missing required field")
    );
    warnSpy.mockRestore();
  });
});

describe("getPostBySlug", () => {
  it("returns the post matching the given slug", async () => {
    mockReaddirSync.mockReturnValue(
      ["post-a.mdx", "post-b.mdx"] as unknown as ReturnType<
        typeof readdirSync
      >
    );
    mockImportMdxMetadata.mockImplementation(async (slug) => {
      if (slug === "post-a") return postA;
      if (slug === "post-b") return postB;
      return undefined;
    });

    const { getPostBySlug } = await import("./index");
    const post = await getPostBySlug("post-a");

    expect(post).toBeDefined();
    expect(post!.title).toBe("Post A");
  });

  it("returns undefined for a draft slug", async () => {
    mockReaddirSync.mockReturnValue(
      ["post-a.mdx", "draft-post.mdx"] as unknown as ReturnType<
        typeof readdirSync
      >
    );
    mockImportMdxMetadata.mockImplementation(async (slug) => {
      if (slug === "post-a") return postA;
      if (slug === "draft-post") return draftPost;
      return undefined;
    });

    const { getPostBySlug } = await import("./index");
    const post = await getPostBySlug("draft-post");

    expect(post).toBeUndefined();
  });
});
