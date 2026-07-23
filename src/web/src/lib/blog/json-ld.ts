import type { BlogPost } from "./types";

export function buildBlogPostingJsonLd(post: BlogPost) {
  return {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: post.title,
    description: post.excerpt,
    datePublished: post.date,
    ...(post.dateModified ? { dateModified: post.dateModified } : {}),
    author: {
      "@type": "Person",
      name: post.author,
    },
    publisher: {
      "@type": "Organization",
      name: "Alook AI",
      url: "https://alook.ai",
    },
    url: `https://alook.ai/blog/${post.slug}`,
    ...(post.image ? { image: `https://alook.ai${post.image}` } : {}),
  };
}
