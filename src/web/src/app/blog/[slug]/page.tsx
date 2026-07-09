import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { getAllPosts, getPostBySlug } from "@/lib/blog/posts";

export const dynamicParams = false;

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

  const ogImage = post.image ?? `/og?title=${encodeURIComponent(post.title)}`;

  return {
    title: `${post.title} — Alook Blog`,
    description: post.excerpt,
    alternates: { canonical: `https://alook.ai/blog/${post.slug}` },
    openGraph: {
      title: post.title,
      description: post.excerpt,
      url: `https://alook.ai/blog/${post.slug}`,
      type: "article",
      publishedTime: post.date,
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
      title: post.title,
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
  const currentIndex = posts.findIndex((p) => p.slug === slug);
  const prevPost = currentIndex < posts.length - 1 ? posts[currentIndex + 1] : null;
  const nextPost = currentIndex > 0 ? posts[currentIndex - 1] : null;

  const { default: PostContent, jsonLd } = await import(
    `@/content/${slug}.mdx`
  );

  const blogPostingJsonLd = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: post.title,
    description: post.excerpt,
    datePublished: post.date,
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
    ...(post.image && { image: `https://alook.ai${post.image}` }),
  };

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
          <h1 className="font-news text-4xl sm:text-5xl font-semibold tracking-tight leading-[1.12]">
            {post.title}
          </h1>
          <div className="mt-6 flex items-center gap-3 text-sm text-muted-foreground">
            <span className="font-medium text-foreground/70">{post.author}</span>
            <span className="text-muted-foreground/40">/</span>
            <span>
              {new Date(post.date).toLocaleDateString("en-US", {
                year: "numeric",
                month: "long",
                day: "numeric",
              })}
            </span>
            <span className="text-muted-foreground/40">/</span>
            <span>{post.readingTime}</span>
          </div>
        </header>

        <div className="blog-content blog-content-editorial font-sans text-lg leading-[1.7] text-foreground max-w-[65ch] [&_h2]:font-sans [&_h2]:text-[1.625rem] [&_h2]:font-semibold [&_h2]:tracking-tight [&_h2]:mt-16 [&_h2]:mb-6 [&_p]:mb-8 [&_blockquote]:border-l-[3px] [&_blockquote]:border-foreground/20 [&_blockquote]:pl-6 [&_blockquote]:italic [&_blockquote]:text-foreground/70 [&_blockquote]:my-10 [&_blockquote]:text-xl [&_blockquote]:leading-relaxed [&_code]:font-mono [&_code]:bg-muted [&_code]:px-2 [&_code]:py-1 [&_code]:rounded [&_code]:text-[0.875em] [&_pre]:bg-muted [&_pre]:rounded-lg [&_pre]:px-4 [&_pre]:py-4 [&_pre]:my-10 [&_pre]:overflow-x-auto [&_pre]:text-[0.875rem] [&_pre]:leading-relaxed [&_pre]:max-w-none [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_img]:rounded-lg [&_img]:my-12 [&_img]:w-full [&_img]:max-w-none [&_ul]:list-disc [&_ul]:pl-6 [&_ul]:mb-8 [&_ul]:-mt-1 [&_li]:mb-3 [&_li]:leading-[1.7] [&_strong]:font-semibold [&_em]:italic [&_a]:underline [&_a]:underline-offset-3 [&_a]:decoration-foreground/30 [&_a]:hover:decoration-foreground/60 [&_a]:transition-colors [&_table]:w-full [&_table]:my-10 [&_table]:border-collapse [&_table]:text-[0.9rem] [&_th]:text-left [&_th]:font-semibold [&_th]:py-3 [&_th]:px-4 [&_th]:border-b-2 [&_th]:border-border [&_td]:py-3 [&_td]:px-4 [&_td]:border-b [&_td]:border-border [&_tr:hover]:bg-muted/50">
          <PostContent />
        </div>

        <nav className="mt-20 border-t border-border pt-10 flex items-stretch justify-between gap-6">
          {prevPost ? (
            <Link
              href={`/blog/${prevPost.slug}`}
              className="group flex flex-col gap-2 text-left max-w-[45%]"
            >
              <span className="text-[11px] uppercase tracking-[0.15em] font-mono text-muted-foreground flex items-center gap-2">
                <ArrowLeft className="size-3" />
                Previous
              </span>
              <span className="text-[15px] font-sans group-hover:-translate-x-0.5 transition-transform duration-200 leading-snug">
                {prevPost.title}
              </span>
            </Link>
          ) : (
            <div />
          )}
          {nextPost ? (
            <Link
              href={`/blog/${nextPost.slug}`}
              className="group flex flex-col gap-2 text-right ml-auto max-w-[45%]"
            >
              <span className="text-[11px] uppercase tracking-[0.15em] font-mono text-muted-foreground flex items-center justify-end gap-2">
                Next
                <ArrowRight className="size-3" />
              </span>
              <span className="text-[15px] font-sans group-hover:translate-x-0.5 transition-transform duration-200 leading-snug">
                {nextPost.title}
              </span>
            </Link>
          ) : (
            <div />
          )}
        </nav>
      </article>
    </>
  );
}
