import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { getAllPosts } from "@blog/lib/blog/posts";
import { blogTopics } from "@blog/lib/blog/topics";
import { buildBlogIndexModel, formatBlogPostDate } from "./model";
import { RecentPosts } from "./recent-posts";

const pageTitle = "Blog";

const description =
  "Thoughts on building AI companies, agent collaboration, and the future of personal software.";

export const metadata: Metadata = {
  title: pageTitle,
  description,
  alternates: {
    canonical: "https://alook.ai/blog",
    types: {
      "application/rss+xml": "/blog/feed.xml",
      "text/markdown": "/llms.txt",
    },
  },
  openGraph: {
    title: pageTitle,
    description,
    url: "https://alook.ai/blog",
  },
  twitter: {
    card: "summary_large_image",
    title: pageTitle,
    description,
  },
};

const collectionJsonLd = {
  "@context": "https://schema.org",
  "@type": "CollectionPage",
  name: pageTitle,
  description,
  url: "https://alook.ai/blog",
};

export default async function BlogPage() {
  const posts = await getAllPosts();
  const { featured, recent } = buildBlogIndexModel(posts);

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(collectionJsonLd) }}
      />
      <div className="mx-auto max-w-270 px-4 pb-24 pt-12 sm:px-6 sm:pt-20">
        <header>
          <h1 className="font-news text-3xl font-semibold leading-none tracking-tight sm:text-[2.5rem] sm:leading-12">
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
                <span className="flex flex-wrap items-center gap-x-3 gap-y-1 font-sans text-sm text-muted-foreground">
                  <span>{featured.topicLabel}</span>
                  <span aria-hidden="true">
                    ·
                  </span>
                  <time dateTime={featured.date}>
                    {formatBlogPostDate(featured.date)}
                  </time>
                </span>
                <h2 className="mt-3 font-news text-3xl font-semibold leading-tight tracking-tight">
                  {featured.title}
                </h2>
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
