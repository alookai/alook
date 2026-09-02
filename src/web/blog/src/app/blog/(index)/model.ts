import type { BlogPost } from "@blog/lib/blog/posts";
import { getBlogTopicBySlug } from "@blog/lib/blog/topics";
import { getBlogOgImage } from "../[slug]/og-image";

export type BlogIndexPost = BlogPost & {
  imageUrl: string;
  topicId: string;
  topicLabel: string;
};

export type BlogIndexModel = {
  featured: BlogIndexPost | undefined;
  recent: BlogIndexPost[];
};

export function buildBlogIndexModel(
  posts: readonly BlogPost[],
): BlogIndexModel {
  const orderedPosts = [...posts].sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
  );
  const indexPosts = orderedPosts.map((post) => {
    const topic = getBlogTopicBySlug(post.slug);

    return {
      ...post,
      imageUrl: getBlogOgImage(post),
      topicId: topic?.id ?? "other",
      topicLabel: topic?.label ?? "More from Alook",
    };
  });

  return {
    featured: indexPosts[0],
    recent: indexPosts.slice(1),
  };
}

export function formatBlogPostDate(date: string): string {
  return new Date(date).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
