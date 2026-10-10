import { ObservedStaticContent } from "@/lib/observability/regions";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { getAllPosts, getPostBySlug } from "@blog/lib/blog/posts";
import { buildBlogPostingJsonLd } from "@blog/lib/blog/json-ld";
import {
  getBlogTopicBySlug,
  getBlogTopicEntryBySlug,
  getNextTopicBridge,
  getRelatedPosts,
} from "@blog/lib/blog/topics";
import { BlogPostByline, buildBlogPostMetadata } from "./article-meta";
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

  return buildBlogPostMetadata(post);
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

  const blogPostingJsonLd = buildBlogPostingJsonLd(
    post,
    getBlogOgImage(post),
  );

  return (
    <>
      <ObservedStaticContent key={slug} pathname={`/blog/${slug}`} />
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
      <article className="blog-article mx-auto max-w-3xl px-6 py-12 sm:py-16">
        <Link
          href="/blog"
          className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors mb-8"
        >
          <ArrowLeft className="size-3.5" />
          All posts
        </Link>

        <header className="mb-10">
          <h1 className="font-sans text-3xl sm:text-[2.5rem] font-semibold tracking-tight leading-tight text-balance">
            {post.title}
          </h1>
          {topic && (
            <Link
              href={`/blog#${topic.id}`}
              className="mt-4 inline-flex rounded-md bg-muted px-2 py-1 text-sm font-medium text-foreground transition-colors hover:bg-accent"
            >
              {topic.label}
            </Link>
          )}
          <BlogPostByline post={post} />
        </header>

        <div className="blog-content blog-prose">
          <PostContent />
        </div>

        {topic && (relatedPosts.length > 0 || nextTopicBridge) && (
          <aside className="mt-16 border-t border-border pt-8">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h2 className="font-sans text-2xl font-semibold tracking-tight">
                  Keep exploring
                </h2>
                <p className="mt-2 text-sm text-muted-foreground">{topic.label}</p>
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
                className="mt-6 divide-y divide-border border-t border-border"
              >
                {relatedPosts.map((relatedPost) => (
                  <Link
                    key={relatedPost.slug}
                    href={`/blog/${relatedPost.slug}`}
                    className="group grid grid-cols-[minmax(0,1fr)_auto] gap-x-6 py-6 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
                  >
                    <span className="col-start-1 font-sans text-lg font-semibold leading-snug group-hover:underline underline-offset-4">
                      {relatedPost.title}
                    </span>
                    <span className="col-start-1 mt-2 text-sm leading-relaxed text-muted-foreground">
                      {getBlogTopicEntryBySlug(relatedPost.slug)?.userJob}
                    </span>
                    <span className="col-start-1 mt-2 text-sm text-muted-foreground">
                      {relatedPost.readingTime}
                    </span>
                    <ArrowRight aria-hidden="true" className="col-start-2 row-start-1 row-span-3 size-5 self-center text-muted-foreground group-hover:text-foreground" />
                  </Link>
                ))}
              </nav>
            )}

            {nextTopicBridge && (
              <Link
                href={`/blog/${nextTopicBridge.post.slug}`}
                className="group mt-8 flex items-center justify-between gap-4 border-t border-border pt-6"
              >
                <span>
                  <span className="block text-sm text-muted-foreground">Next Blog</span>
                  <span className="mt-2 block font-sans text-lg font-semibold leading-snug group-hover:text-muted-foreground transition-colors">
                    {nextTopicBridge.post.title}
                  </span>
                  <span className="mt-2 block text-sm text-muted-foreground">
                    {nextTopicBridge.topic.label}
                  </span>
                </span>
                <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
              </Link>
            )}
          </aside>
        )}
      </article>
    </>
  );
}
