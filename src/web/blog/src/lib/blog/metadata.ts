import type { BlogPost } from "./types";

export function getBlogSearchTitle(
  post: Pick<BlogPost, "title" | "seoTitle">
): string {
  return post.seoTitle ?? post.title;
}

export function getBlogOgImage(post: Pick<BlogPost, "image" | "slug">): string {
  return post.image ?? `/og/blog/${encodeURIComponent(post.slug)}`;
}
