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
  it("imports and returns only the requested canonical post without scanning", async () => {
    mockImportMdxMetadata.mockResolvedValue(postA);

    const { getPostBySlug } = await import("./get-post-by-slug");
    const post = await getPostBySlug("post-a");

    expect(post).toEqual(postA);
    expect(mockImportMdxMetadata).toHaveBeenCalledWith("post-a");
    expect(mockReaddirSync).not.toHaveBeenCalled();
  });

  it("returns undefined for a draft slug", async () => {
    mockImportMdxMetadata.mockResolvedValue(draftPost);

    const { getPostBySlug } = await import("./get-post-by-slug");
    const post = await getPostBySlug("draft-post");

    expect(post).toBeUndefined();
    expect(mockReaddirSync).not.toHaveBeenCalled();
  });

  it("returns undefined for missing or incomplete metadata", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { getPostBySlug } = await import("./get-post-by-slug");

    mockImportMdxMetadata.mockResolvedValueOnce(undefined);
    await expect(getPostBySlug("missing")).resolves.toBeUndefined();

    mockImportMdxMetadata.mockResolvedValueOnce(incompletePost);
    await expect(getPostBySlug("incomplete")).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("missing required field")
    );
    expect(mockReaddirSync).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("returns undefined when metadata slug does not match the requested module", async () => {
    mockImportMdxMetadata.mockResolvedValue(postB);

    const { getPostBySlug } = await import("./get-post-by-slug");

    await expect(getPostBySlug("post-a")).resolves.toBeUndefined();
    expect(mockReaddirSync).not.toHaveBeenCalled();
  });

  it("propagates unexpected MDX import failures", async () => {
    const failure = new Error("MDX evaluation failed");
    mockImportMdxMetadata.mockRejectedValue(failure);

    const { getPostBySlug } = await import("./get-post-by-slug");

    await expect(getPostBySlug("post-a")).rejects.toBe(failure);
    expect(mockReaddirSync).not.toHaveBeenCalled();
  });
});
