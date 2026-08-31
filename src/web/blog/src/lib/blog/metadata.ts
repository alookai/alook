import type { BlogPost } from "./types";

export function getBlogSearchTitle(
  post: Pick<BlogPost, "title" | "seoTitle">
): string {
  return post.seoTitle ?? post.title;
}
