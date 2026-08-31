import type { BlogPost } from "../types";
import { blogTopics } from "../topics";
import { importMdxMetadata } from "./import-mdx";
import { validateMetadata } from "./validate-metadata";

const publishedSlugs = blogTopics.flatMap((topic) =>
  topic.entries.map((entry) => entry.slug)
);

let cachedPosts: BlogPost[] | null = null;

export type { BlogPost } from "../types";
export { getPostBySlug } from "./get-post-by-slug";

export async function getAllPosts(): Promise<BlogPost[]> {
  if (cachedPosts) {
    return [...cachedPosts].sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
    );
  }

  const posts: BlogPost[] = [];

  for (const slug of publishedSlugs) {
    const file = `${slug}.mdx`;
    const metadata = await importMdxMetadata(slug);

    if (
      !metadata ||
      !validateMetadata(metadata as Record<string, unknown>, file)
    )
      continue;
    if (metadata.draft) continue;

    posts.push(metadata);
  }

  cachedPosts = posts;

  return [...posts].sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
  );
}
