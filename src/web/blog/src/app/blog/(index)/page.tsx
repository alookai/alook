import { ObservedStaticContent } from "@/lib/observability/regions";
import { buildPublicPageMetadata } from "@/lib/seo/public-page-metadata";
import Image from "next/image";
import Link from "next/link";
import { isGuide } from "@blog/lib/blog/guides";
import { getAllPosts } from "@blog/lib/blog/posts";
import { blogTopics } from "@blog/lib/blog/topics";
import { buildBlogIndexModel, formatBlogPostDate } from "./model";
import { RecentPosts } from "./recent-posts";

const pageTitle = "Blog";

const description =
  "Read Alook articles on AI agent collaboration, multi-agent workflows, and shared context for teams working with Claude Code, Codex, and other agents.";

export const metadata = buildPublicPageMetadata({
  title: "Blog — AI Agent Collaboration & Workflows — Alook",
  description,
  path: "/blog",
  alternateTypes: {
    "application/rss+xml": "/blog/feed.xml",
    "text/markdown": "/llms.txt",
  },
});

const collectionJsonLd = {
  "@context": "https://schema.org",
  "@type": "CollectionPage",
  name: pageTitle,
  description,
  url: "https://alook.ai/blog",
};

export default async function BlogPage() {
  const posts = (await getAllPosts()).filter((post) => !isGuide(post));
  const { featured, recent } = buildBlogIndexModel(posts);

  return (
    <>
      <ObservedStaticContent key="/blog" pathname="/blog" />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(collectionJsonLd) }}
      />
      <div className="mx-auto max-w-270 px-4 pb-24 pt-12 sm:px-6 sm:pt-20">
        <header>
          <h1 className="font-sans text-3xl font-semibold leading-none tracking-tight sm:text-[2.5rem] sm:leading-12">
            Blog
          </h1>
        </header>

        {featured ? (
          <section aria-label="Featured article" className="mt-8">
            <Link
              href={`/blog/${featured.slug}`}
              className="group grid rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background sm:grid-cols-2 sm:gap-12"
            >
              <span className="relative block aspect-video overflow-hidden rounded-lg bg-muted">
                <Image
                  src={featured.imageUrl}
                  alt=""
                  fill
                  preload
                  sizes="(max-width: 639px) calc(100vw - 2rem), 31rem"
                  className="object-cover transition-transform duration-200 group-hover:scale-[1.015] motion-reduce:transform-none"
                />
              </span>
              <span className="flex flex-col justify-center pt-6 sm:py-4">
                <h2 className="font-sans text-3xl font-semibold leading-tight tracking-tight">
                  {featured.title}
                </h2>
                <span className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 font-sans text-sm text-muted-foreground">
                  <span className="rounded-md bg-muted px-2 py-1 text-foreground">{featured.topicLabel}</span>
                  <time dateTime={featured.date}>
                    {formatBlogPostDate(featured.date)}
                  </time>
                </span>
                <span className="mt-3 line-clamp-3 font-sans leading-relaxed text-foreground/70">
                  {featured.excerpt}
                </span>
              </span>
            </Link>
          </section>
        ) : (
          <p className="mt-16 font-sans text-muted-foreground">
            New stories are on the way.
          </p>
        )}

        <RecentPosts
          posts={recent}
          topics={blogTopics.map(({ id, label }) => ({ id, label }))}
        />
      </div>
    </>
  );
}
