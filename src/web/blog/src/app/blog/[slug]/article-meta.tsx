import type { Metadata } from "next";
import type { BlogPost } from "@blog/lib/blog/posts";
import { getBlogSearchTitle } from "@blog/lib/blog/metadata";
import { getBlogOgImage } from "./og-image";

export function buildBlogPostMetadata(post: BlogPost): Metadata {
  const ogImage = getBlogOgImage(post);
  const searchTitle = getBlogSearchTitle(post);

  return {
    title: searchTitle,
    description: post.excerpt,
    alternates: { canonical: `https://alook.ai/blog/${post.slug}` },
    openGraph: {
      title: searchTitle,
      description: post.excerpt,
      url: `https://alook.ai/blog/${post.slug}`,
      type: "article",
      publishedTime: post.date,
      ...(post.dateModified ? { modifiedTime: post.dateModified } : {}),
      authors: [post.author],
      images: [
        {
          url: ogImage,
          width: 1200,
          height: 630,
          alt: searchTitle,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: searchTitle,
      description: post.excerpt,
      images: [ogImage],
    },
  };
}

export function BlogPostByline({
  post,
}: {
  post: Pick<BlogPost, "author" | "date" | "dateModified" | "readingTime">;
}) {
  return (
    <div className="mt-6 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
      <span className="font-medium text-foreground/70">{post.author}</span>
      <span className="text-muted-foreground/40">/</span>
      <time dateTime={post.date}>{formatArticleDate(post.date)}</time>
      {post.dateModified && post.dateModified !== post.date ? (
        <>
          <span className="text-muted-foreground/40">/</span>
          <time dateTime={post.dateModified}>
            Updated {formatArticleDate(post.dateModified)}
          </time>
        </>
      ) : null}
      <span className="text-muted-foreground/40">/</span>
      <span>{post.readingTime}</span>
    </div>
  );
}

function formatArticleDate(date: string): string {
  return new Date(date).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}
