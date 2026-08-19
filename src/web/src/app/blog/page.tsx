import type { Metadata } from "next";
import Link from "next/link";
import { getAllPosts } from "@/lib/blog/posts";
import {
  blogTopics,
  getBlogTopicEntryBySlug,
  getPostsForTopic,
} from "@/lib/blog/topics";

const pageTitle = "Multi-Agent Collaboration & AI Team";

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
    images: [
      {
        url: `/og?title=${encodeURIComponent(pageTitle)}`,
        width: 1200,
        height: 630,
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: pageTitle,
    description,
    images: [`/og?title=${encodeURIComponent(pageTitle)}`],
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

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(collectionJsonLd) }}
      />
      <div className="mx-auto max-w-5xl px-6 pt-10 sm:pt-20 pb-24">
        <header className="max-w-3xl">
          <h1 className="font-news text-5xl sm:text-6xl font-semibold tracking-tight leading-none">
            {pageTitle}
          </h1>
          <p className="mt-4 text-[1.0625rem] text-muted-foreground font-sans leading-relaxed max-w-xl">
            {description}
          </p>
          <p className="mt-4 text-xs font-mono uppercase tracking-[0.15em] text-muted-foreground/60">
            <a
              href="/blog/feed.xml"
              className="transition-opacity hover:opacity-70"
            >
              RSS
            </a>
            <span className="mx-2 opacity-40">·</span>
            <a href="/llms.txt" className="transition-opacity hover:opacity-70">
              llms.txt
            </a>
          </p>
        </header>

        <nav
          aria-label="Blog topics"
          className="mt-12 grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-2 lg:grid-cols-4"
        >
          {blogTopics.map((topic, index) => (
            <a
              key={topic.id}
              href={`#${topic.id}`}
              className="group bg-background px-5 py-5 transition-colors hover:bg-muted/60"
            >
              <span className="font-mono text-[11px] tabular-nums text-muted-foreground/50">
                {String(index + 1).padStart(2, "0")}
              </span>
              <span className="mt-3 block font-sans text-sm font-medium leading-snug group-hover:translate-x-0.5 transition-transform duration-200">
                {topic.label}
              </span>
            </a>
          ))}
        </nav>

        <div className="mt-24 space-y-24">
          {blogTopics.map((topic, topicIndex) => {
            const topicPosts = getPostsForTopic(topic, posts);
            const pillar = topicPosts.find(
              (post) => post.slug === topic.pillarSlug
            );
            const supportPosts = topicPosts.filter(
              (post) => post.slug !== topic.pillarSlug
            );

            return (
              <section
                key={topic.id}
                id={topic.id}
                className="scroll-mt-24"
                aria-labelledby={`${topic.id}-heading`}
              >
                <div className="grid gap-5 border-t border-border pt-7 md:grid-cols-[11rem_1fr] md:gap-10">
                  <p className="font-mono text-xs uppercase tracking-[0.16em] text-muted-foreground/60">
                    Topic {String(topicIndex + 1).padStart(2, "0")}
                  </p>
                  <div>
                    <h2
                      id={`${topic.id}-heading`}
                      className="font-news text-3xl sm:text-4xl font-semibold tracking-tight leading-tight"
                    >
                      {topic.label}
                    </h2>
                    <p className="mt-3 max-w-2xl font-sans text-foreground/70 leading-relaxed">
                      {topic.description}
                    </p>
                  </div>
                </div>

                {pillar && (
                  <Link
                    href={`/blog/${pillar.slug}`}
                    className="group mt-10 block rounded-xl border border-border bg-muted/25 p-6 sm:p-8 transition-colors hover:bg-muted/50"
                  >
                    <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground/60">
                      Start here
                    </span>
                    <div className="mt-4 grid gap-4 md:grid-cols-[1fr_14rem] md:gap-10">
                      <div>
                        <h3 className="font-news text-2xl sm:text-3xl font-semibold tracking-tight leading-tight group-hover:translate-x-0.5 transition-transform duration-200">
                          {pillar.title}
                        </h3>
                        <p className="mt-3 font-sans text-foreground/75 leading-relaxed">
                          {pillar.excerpt}
                        </p>
                      </div>
                      <div className="md:border-l md:border-border md:pl-6">
                        <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground/60">
                          Use this to
                        </p>
                        <p className="mt-2 text-sm leading-relaxed text-foreground/80">
                          {getBlogTopicEntryBySlug(pillar.slug)?.userJob}
                        </p>
                        <p className="mt-4 text-xs text-muted-foreground">
                          {formatPostDate(pillar.date)} &middot;{" "}
                          {pillar.readingTime}
                        </p>
                      </div>
                    </div>
                  </Link>
                )}

                <div className="mt-4 grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-2">
                  {supportPosts.map((post) => (
                    <article key={post.slug} className="bg-background">
                      <Link
                        href={`/blog/${post.slug}`}
                        className="group flex h-full flex-col p-6 transition-colors hover:bg-muted/40"
                      >
                        <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground/60">
                          {getBlogTopicEntryBySlug(post.slug)?.userJob}
                        </p>
                        <h3 className="mt-3 font-news text-xl sm:text-2xl font-semibold tracking-tight leading-snug group-hover:translate-x-0.5 transition-transform duration-200">
                          {post.title}
                        </h3>
                        <p className="mt-3 font-sans text-sm text-foreground/70 leading-relaxed">
                          {post.excerpt}
                        </p>
                        <p className="mt-auto pt-5 text-xs text-muted-foreground">
                          {formatPostDate(post.date)} &middot; {post.readingTime}
                        </p>
                      </Link>
                    </article>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </>
  );
}

function formatPostDate(date: string): string {
  return new Date(date).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}
