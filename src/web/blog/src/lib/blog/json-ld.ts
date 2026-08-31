import type { BlogPost } from "./types";
import { ALOOK_ORGANIZATION } from "@/lib/seo/entities";

export function buildBlogPostingJsonLd(post: BlogPost) {
  return {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: post.title,
    description: post.excerpt,
    datePublished: post.date,
    ...(post.dateModified ? { dateModified: post.dateModified } : {}),
    author:
      post.author === "Alook Team"
        ? { ...ALOOK_ORGANIZATION }
        : {
            "@type": "Person",
            name: post.author,
          },
    publisher: { ...ALOOK_ORGANIZATION },
    url: `https://alook.ai/blog/${post.slug}`,
    ...(post.image ? { image: `https://alook.ai${post.image}` } : {}),
  };
}
