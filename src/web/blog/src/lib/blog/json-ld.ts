import type { BlogPost } from "./types";
import { ALOOK_ORGANIZATION } from "@/lib/seo/entities";

const siteUrl = "https://alook.ai";

export function buildBlogPostingJsonLd(post: BlogPost, resolvedOgImage: string) {
  const canonicalUrl = `${siteUrl}/blog/${post.slug}`;

  return {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: post.title,
    description: post.excerpt,
    datePublished: post.date,
    ...(post.dateModified ? { dateModified: post.dateModified } : {}),
    author:
      post.author === "Alook Team"
        ? {
            "@type": "Organization",
            name: "Alook Team",
            url: "https://alook.ai/blog",
          }
        : {
            "@type": "Person",
            name: post.author,
          },
    publisher: { ...ALOOK_ORGANIZATION },
    mainEntityOfPage: {
      "@type": "WebPage",
      "@id": canonicalUrl,
    },
    url: canonicalUrl,
    image: new URL(resolvedOgImage, siteUrl).toString(),
  };
}
