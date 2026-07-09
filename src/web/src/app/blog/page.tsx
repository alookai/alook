import type { Metadata } from "next";
import Link from "next/link";
import { getAllPosts } from "@/lib/blog/posts";

const description =
  "Thoughts on building AI companies, agent collaboration, and the future of personal software.";

export const metadata: Metadata = {
  title: "Blog",
  description,
  alternates: {
    canonical: "https://alook.ai/blog",
    types: { "application/rss+xml": "/blog/feed.xml" },
  },
  openGraph: {
    title: "Blog",
    description,
    url: "https://alook.ai/blog",
    images: [{ url: "/og?title=Blog", width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Blog",
    description,
    images: ["/og?title=Blog"],
  },
};

const collectionJsonLd = {
  "@context": "https://schema.org",
  "@type": "CollectionPage",
  name: "Alook Blog",
  description,
  url: "https://alook.ai/blog",
};

export default async function BlogPage() {
  const posts = await getAllPosts();
  const [featured, ...rest] = posts;

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(collectionJsonLd) }}
      />
      <div className="mx-auto max-w-3xl px-6 pt-10 sm:pt-20 pb-24">
        <header className="mb-16">
          <h1 className="font-news text-5xl sm:text-6xl font-semibold tracking-tight leading-none">
            Blog
          </h1>
          <p className="mt-4 text-[1.0625rem] text-muted-foreground font-sans leading-relaxed max-w-xl">
            {description}
          </p>
        </header>

        {featured && (
          <Link
            href={`/blog/${featured.slug}`}
            className="group block pb-14 mb-14 border-b border-border"
          >
            <span className="text-xs font-mono uppercase tracking-[0.2em] text-muted-foreground/60">
              Latest
            </span>
            <h2 className="mt-3 font-news text-3xl sm:text-4xl font-semibold tracking-tight leading-tight group-hover:translate-x-1 transition-transform duration-200">
              {featured.title}
            </h2>
            <p className="mt-3 text-sm text-muted-foreground">
              {new Date(featured.date).toLocaleDateString("en-US", {
                year: "numeric",
                month: "long",
                day: "numeric",
              })}{" "}
              &middot; {featured.readingTime}
            </p>
            <p className="mt-4 font-sans text-lg text-foreground/80 leading-relaxed max-w-2xl">
              {featured.excerpt}
            </p>
          </Link>
        )}

        <div className="space-y-0">
          {rest.map((post, i) => (
            <article
              key={post.slug}
              className={`py-10 ${i < rest.length - 1 ? "border-b border-border" : ""}`}
            >
              <Link href={`/blog/${post.slug}`} className="group block">
                <div className="flex items-baseline gap-4">
                  <span className="text-xs font-mono text-muted-foreground/40 tabular-nums w-6 shrink-0">
                    {String(i + 2).padStart(2, "0")}
                  </span>
                  <div>
                    <h2 className="font-news text-xl sm:text-2xl font-semibold tracking-tight group-hover:translate-x-0.5 transition-transform duration-200">
                      {post.title}
                    </h2>
                    <p className="mt-2 text-sm text-muted-foreground">
                      {new Date(post.date).toLocaleDateString("en-US", {
                        year: "numeric",
                        month: "long",
                        day: "numeric",
                      })}{" "}
                      &middot; {post.readingTime}
                    </p>
                    <p className="mt-3 font-sans text-foreground/75 leading-relaxed">
                      {post.excerpt}
                    </p>
                  </div>
                </div>
              </Link>
            </article>
          ))}
        </div>
      </div>
    </>
  );
}
