import type { BlogPost } from "@/lib/blog/posts";

export function getBlogOgImage(post: Pick<BlogPost, "image" | "slug">): string {
  return post.image ?? `/og/blog/${encodeURIComponent(post.slug)}`;
}
