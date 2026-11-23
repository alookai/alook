import { ObservedStaticContent } from "@/lib/observability/regions";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import technostalgia from "@/components/brand/technostalgia.module.css";
import { ArrowLeft, ArrowRight } from "@/components/icons/lucide";
import { getAllPosts, getPostBySlug } from "@blog/lib/blog/posts";
import { buildBlogPostingJsonLd } from "@blog/lib/blog/json-ld";
import { getBlogTopicBySlug, getNextTopicBridge } from "@blog/lib/blog/topics";
import { getBlogHeadingsBySlug } from "@blog/lib/blog/headings";
import { getBlogConversionCopy } from "@blog/lib/blog/conversion-copy";
import { BlogToc } from "@blog/components/blog/blog-toc";
import { BlogNewsletterForm } from "@blog/components/blog/blog-newsletter-form";
import { BlogMidCallout } from "@blog/components/blog/blog-mid-callout";
import { BlogEndCta } from "@blog/components/blog/blog-end-cta";
import { BlogPostByline, buildBlogPostMetadata } from "./article-meta";
import { getBlogOgImage } from "@blog/lib/blog/metadata";

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
  const nextTopicBridge = getNextTopicBridge(slug, posts);
  const headings = getBlogHeadingsBySlug(slug);
  const conversionCopy = getBlogConversionCopy(topic?.id);

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
      <div className="mx-auto max-w-3xl px-6 py-12 sm:py-16 lg:max-w-290 lg:px-14">
        <div className="lg:grid lg:grid-cols-[minmax(0,720px)_260px] lg:justify-between lg:gap-8 xl:grid-cols-[minmax(0,720px)_280px] xl:gap-12">
          <article className="blog-article min-w-0">
            <Link
              href="/blog"
              className="tn-blog-back inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors mb-8"
            >
              <ArrowLeft className="size-3.5" />
              All posts
            </Link>

            <header className="mb-10">
              <h1 className="font-sans text-3xl sm:text-[2.5rem] font-semibold tracking-tight leading-tight text-balance">
                {post.title}
              </h1>
              {topic && (
                <div className={`${technostalgia.theme} mt-4 w-fit`}>
                  <Badge variant="secondary" className="h-auto py-1 text-sm" render={<Link href={`/blog#${topic.id}`} />}>
                    {topic.label}
                  </Badge>
                </div>
              )}
              <BlogPostByline post={post} />
            </header>

            <div className="blog-content blog-prose" data-blog-prose>
              <PostContent />
            </div>

            <BlogMidCallout copy={conversionCopy.mid} headingCount={headings.length} />

            <BlogEndCta copy={conversionCopy.end} />

            <div className="mt-8">
              <BlogNewsletterForm placement="end" slug={slug} />
            </div>

            {nextTopicBridge && (
              <aside data-blog-recommendations className="mt-10">
                <Link
                  href={`/blog/${nextTopicBridge.post.slug}`}
                  className="tn-blog-card group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 overflow-hidden p-3 sm:grid-cols-[12rem_minmax(0,1fr)_auto] sm:gap-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background"
                >
                  <span className="tn-blog-post-image relative hidden overflow-hidden rounded-[10px] border sm:block">
                    <Image src={getBlogOgImage(nextTopicBridge.post)} alt="" fill sizes="12rem" className="object-cover" />
                  </span>
                  <span className="min-w-0 py-1 pl-1 sm:pl-0">
                    <span className="block text-sm text-muted-foreground">Next Blog</span>
                    <span className="mt-1 block font-sans text-lg font-semibold leading-snug text-pretty">{nextTopicBridge.post.title}</span>
                    <span className="mt-1 block text-sm text-muted-foreground">{nextTopicBridge.topic.label}</span>
                  </span>
                  <span className="tn-blog-key mr-1" aria-hidden="true"><ArrowRight size={16} /></span>
                </Link>
              </aside>
            )}

            <div className="mt-10 border-t border-border pt-6">
              <Link href="/blog" className="tn-blog-back inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground">
                <ArrowLeft className="size-3.5" />
                More blogs
              </Link>
            </div>
          </article>

          <aside
            aria-label="Article navigation and actions"
            data-testid="blog-sticky-rail"
            className="hidden lg:block"
          >
            <div className="sticky top-20 max-h-[calc(100vh-5.5rem)] overflow-y-auto thin-scrollbar pb-4 pr-1">
              <BlogToc headings={headings} title={post.title} slug={slug} />
            </div>
          </aside>
        </div>
      </div>
    </>
  );
}
