import type { BlogPost } from "@blog/lib/blog/posts";
import { getBlogTopicBySlug } from "@blog/lib/blog/topics";
import { getBlogOgImage } from "@blog/lib/blog/metadata";

export type BlogPostCard = BlogPost & {
  imageUrl: string;
  topicId: string;
  topicLabel: string;
};

export function buildBlogPostCards(
  posts: readonly BlogPost[],
): BlogPostCard[] {
  const orderedPosts = [...posts].sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
  );
  return orderedPosts.map((post) => {
    const topic = getBlogTopicBySlug(post.slug);

    return {
      ...post,
      imageUrl: getBlogOgImage(post),
      topicId: topic?.id ?? "other",
      topicLabel: topic?.label ?? "More from Alook",
    };
  });
}

export function formatBlogPostDate(date: string): string {
  return new Date(date).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}
