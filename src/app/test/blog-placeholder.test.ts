import { describe, expect, it } from "vitest";
import {
  BLOG_PLACEHOLDER_FILENAME,
  BLOG_PLACEHOLDER_SOURCE,
} from "../scripts/blog-placeholder";
import { readBlogMetadata } from "../../web/src/lib/blog/validate-assets";

describe("blog bundle placeholder", () => {
  it("satisfies the blog metadata contract", () => {
    const fileSlug = BLOG_PLACEHOLDER_FILENAME.replace(/\.mdx$/, "");

    expect(readBlogMetadata(BLOG_PLACEHOLDER_SOURCE, fileSlug).errors).toEqual([]);
  });
});
