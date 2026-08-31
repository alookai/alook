import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { getAllPosts, getPostBySlug } from "@blog/lib/blog/posts";
import { buildBlogPostingJsonLd } from "@blog/lib/blog/json-ld";
import { getBlogSearchTitle } from "@blog/lib/blog/metadata";
import {
  getBlogTopicBySlug,
  getBlogTopicEntryBySlug,
  getNextTopicBridge,
  getRelatedPosts,
} from "@blog/lib/blog/topics";
import { getBlogOgImage } from "./og-image";

// The ASSETS-only Worker intentionally has no incremental-cache binding, so a
// prerender cache miss must be allowed to render the canonical slug at runtime.
export const dynamicParams = true;

export async function generateStaticParams(): Promise<{ slug: string }[]> {
  const posts = await getAllPosts();
  return posts.map((post) => ({ slug: post.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const post = await getPostBySlug(slug);
  if (!post) return {};

  // Preserve existing hero images. Only posts without one use the bounded,
  // route-owned fallback; unlike the retired query route, the slug is resolved
  // against canonical post metadata on the server.
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

export default async function BlogPostPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const post = await getPostBySlug(slug);
  if (!post) notFound();

  const posts = await getAllPosts();
  const topic = getBlogTopicBySlug(slug);
  const relatedPosts = getRelatedPosts(slug, posts);
  const nextTopicBridge = getNextTopicBridge(slug, posts);

  const { default: PostContent, jsonLd } = await import(
    `@blog/content/${slug}.mdx`
  );

  const blogPostingJsonLd = buildBlogPostingJsonLd(post);

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(blogPostingJsonLd) }}
      />
      {jsonLd && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(Array.isArray(jsonLd) ? jsonLd : [jsonLd]),
          }}
        />
      )}
      <article className="mx-auto max-w-3xl px-6 pt-12 sm:pt-24 pb-28">
        <Link
          href="/blog"
          className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors mb-8 sm:mb-14"
        >
          <ArrowLeft className="size-3.5" />
          All posts
        </Link>

        <header className="mb-10 sm:mb-16">
          {topic && (
            <Link
              href={`/blog#${topic.id}`}
              className="mb-4 inline-block font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground transition-colors hover:text-foreground"
            >
              {topic.label}
            </Link>
          )}
          <h1 className="font-news text-4xl sm:text-5xl font-semibold tracking-tight leading-[1.12]">
            {post.title}
          </h1>
          <div className="mt-6 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
            <span className="font-medium text-foreground/70">{post.author}</span>
            <span className="text-muted-foreground/40">/</span>
            <span>
              {new Date(post.date).toLocaleDateString("en-US", {
                year: "numeric",
                month: "long",
                day: "numeric",
              })}
            </span>
            {post.dateModified && post.dateModified !== post.date ? (
              <>
                <span className="text-muted-foreground/40">/</span>
                <span>
                  Updated{" "}
                  {new Date(post.dateModified).toLocaleDateString("en-US", {
                    year: "numeric",
                    month: "long",
                    day: "numeric",
                  })}
                </span>
              </>
            ) : null}
            <span className="text-muted-foreground/40">/</span>
            <span>{post.readingTime}</span>
          </div>
        </header>

        <div className="blog-content blog-content-editorial font-sans text-lg leading-[1.7] text-foreground max-w-[65ch] [&_h2]:font-sans [&_h2]:text-[1.625rem] [&_h2]:font-semibold [&_h2]:tracking-tight [&_h2]:mt-16 [&_h2]:mb-6 [&_p]:mb-8 [&_blockquote]:border-l-[3px] [&_blockquote]:border-foreground/20 [&_blockquote]:pl-6 [&_blockquote]:italic [&_blockquote]:text-foreground/70 [&_blockquote]:my-10 [&_blockquote]:text-xl [&_blockquote]:leading-relaxed [&_code]:font-mono [&_code]:bg-muted [&_code]:px-2 [&_code]:py-1 [&_code]:rounded [&_code]:text-[0.875em] [&_pre]:bg-muted [&_pre]:rounded-lg [&_pre]:px-4 [&_pre]:py-4 [&_pre]:my-10 [&_pre]:overflow-x-auto [&_pre]:text-[0.875rem] [&_pre]:leading-relaxed [&_pre]:max-w-none [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_img]:rounded-lg [&_img]:my-12 [&_img]:w-full [&_img]:max-w-none [&_ul]:list-disc [&_ul]:pl-6 [&_ul]:mb-8 [&_ul]:-mt-1 [&_li]:mb-3 [&_li]:leading-[1.7] [&_strong]:font-semibold [&_em]:italic [&_a]:underline [&_a]:underline-offset-3 [&_a]:decoration-foreground/30 [&_a]:hover:decoration-foreground/60 [&_a]:transition-colors [&_table]:w-full [&_table]:my-10 [&_table]:border-collapse [&_table]:text-[0.9rem] [&_th]:text-left [&_th]:font-semibold [&_th]:py-3 [&_th]:px-4 [&_th]:border-b-2 [&_th]:border-border [&_td]:py-3 [&_td]:px-4 [&_td]:border-b [&_td]:border-border [&_tr:hover]:bg-muted/50">
          <PostContent />
        </div>

        {topic && (relatedPosts.length > 0 || nextTopicBridge) && (
          <aside className="mt-20 border-t border-border pt-10">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground/60">
                  Keep exploring
                </p>
                <h2 className="mt-2 font-news text-2xl sm:text-3xl font-semibold tracking-tight">
                  {topic.label}
                </h2>
              </div>
              <Link
                href={`/blog#${topic.id}`}
                className="text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                All in this topic
              </Link>
            </div>

            {relatedPosts.length > 0 && (
              <nav
                aria-label={`More in ${topic.label}`}
                className="mt-7 grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-3"
              >
                {relatedPosts.map((relatedPost) => (
                  <Link
                    key={relatedPost.slug}
                    href={`/blog/${relatedPost.slug}`}
                    className="group flex min-h-44 flex-col bg-background p-5 transition-colors hover:bg-muted/50"
                  >
                    <span className="font-mono text-[10px] uppercase tracking-[0.13em] text-muted-foreground/60">
                      {getBlogTopicEntryBySlug(relatedPost.slug)?.userJob}
                    </span>
                    <span className="mt-3 font-news text-lg font-semibold leading-snug tracking-tight group-hover:translate-x-0.5 transition-transform duration-200">
                      {relatedPost.title}
                    </span>
                    <span className="mt-auto pt-4 text-xs text-muted-foreground">
                      {relatedPost.readingTime}
                    </span>
                  </Link>
                ))}
              </nav>
            )}

            {nextTopicBridge && (
              <Link
                href={`/blog/${nextTopicBridge.post.slug}`}
                className="group mt-5 grid gap-3 rounded-xl border border-border p-5 transition-colors hover:bg-muted/40 sm:grid-cols-[9rem_1fr_auto] sm:items-center sm:gap-6"
              >
                <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground/60">
                  Next topic
                </span>
                <span>
                  <span className="block text-xs text-muted-foreground">
                    {nextTopicBridge.topic.label}
                  </span>
                  <span className="mt-1 block font-news text-lg font-semibold leading-snug tracking-tight">
                    {nextTopicBridge.post.title}
                  </span>
                </span>
                <ArrowRight className="hidden size-4 text-muted-foreground transition-transform duration-200 group-hover:translate-x-1 sm:block" />
              </Link>
            )}
          </aside>
        )}
      </article>
    </>
  );
}
