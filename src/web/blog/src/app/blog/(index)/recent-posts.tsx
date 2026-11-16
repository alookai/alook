"use client";

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import technostalgia from "@/components/brand/technostalgia.module.css";
import { useAtom, useCreateAtom } from "@tanstack/react-store";
import { useEffect, useMemo } from "react";
import Image from "next/image";
import Link from "next/link";
import {
  useHorizontalOverflowRail,
} from "@/components/horizontal-overflow-rail";
import { useHoverCapable } from "@/hooks/use-hover-capable";
import { useBreakpoint } from "@/hooks/use-mobile";
import type { BlogPostCard } from "@blog/lib/blog/post-cards";
import { formatBlogPostDate } from "@blog/lib/blog/post-cards";

type BlogTopicFilter = {
  id: string;
  label: string;
};

type RecentPostsProps = {
  posts: readonly BlogPostCard[];
  topics: readonly BlogTopicFilter[];
  hrefBase?: string;
  heading?: string;
  filterLabel?: string;
};

const allTopicsId = "all";

export function subscribeToRecentPostsTopicHash(
  topicIds: ReadonlySet<string>,
  selectTopic: (topicId: string) => void,
): (() => void) | undefined {
  if (typeof window === "undefined") return;

  const syncTopicFromHash = () => {
    const hashTopicId = decodeURIComponent(window.location.hash.slice(1));
    selectTopic(topicIds.has(hashTopicId) ? hashTopicId : allTopicsId);
  };

  syncTopicFromHash();
  window.addEventListener("hashchange", syncTopicFromHash);
  return () => window.removeEventListener("hashchange", syncTopicFromHash);
}

export function replaceRecentPostsTopicUrl(topicId: string) {
  if (typeof window === "undefined") return;

  const nextUrl =
    topicId === allTopicsId
      ? `${window.location.pathname}${window.location.search}`
      : `${window.location.pathname}${window.location.search}#${topicId}`;
  window.history.replaceState(null, "", nextUrl);
}

export function RecentPosts({ posts, topics, hrefBase = "/blog", heading = "Recent posts", filterLabel = "Filter recent posts" }: RecentPostsProps) {
  const [selectedTopicId, setSelectedTopicId] = useAtom(useCreateAtom(allTopicsId));
  const breakpoint = useBreakpoint();
  const hoverCapable = useHoverCapable();
  const topicIds = useMemo(() => new Set(topics.map((topic) => topic.id)), [topics]);
  const topicKey = useMemo(
    () => topics.map((topic) => `${topic.id}\0${topic.label}`).join("\0"),
    [topics],
  );
  const {
    scrollerRef,
    selectedRef,
  } = useHorizontalOverflowRail<HTMLDivElement, HTMLButtonElement>({
    contentKey: topicKey,
    selectedKey: selectedTopicId,
    mapVerticalWheelToHorizontal:
      breakpoint === "desktop" && hoverCapable,
    dragToScroll: true,
  });
  const visiblePosts =
    selectedTopicId === allTopicsId
      ? posts
      : posts.filter((post) => post.topicId === selectedTopicId);

  useEffect(() => {
    return subscribeToRecentPostsTopicHash(topicIds, setSelectedTopicId);
  }, [setSelectedTopicId, topicIds]);

  const selectTopic = (topicId: string) => {
    setSelectedTopicId(topicId);
    replaceRecentPostsTopicUrl(topicId);
  };

  return (
    <section aria-labelledby="recent-posts-heading" className="mt-12 sm:mt-20">
      <h2
        id="recent-posts-heading"
        className="font-sans text-2xl font-semibold tracking-tight sm:text-3xl"
      >
        {heading}
      </h2>
      <div className="relative mt-3 sm:mt-6">
        <div
          ref={scrollerRef}
          data-testid="blog-topic-scroller"
          className="thin-scrollbar scrollbar-none overflow-x-auto scroll-fade-x scroll-fade-4 scroll-px-4 px-4"
        >
          <Tabs value={selectedTopicId} onValueChange={(value) => selectTopic(String(value))} className={`${technostalgia.theme} w-max min-w-full py-1`}>
            <TabsList aria-label={filterLabel} className="overflow-visible">
              <TabsTrigger value={allTopicsId} ref={selectedTopicId === allTopicsId ? selectedRef : undefined}>All</TabsTrigger>
              {topics.map((topic) => (
                <TabsTrigger key={topic.id} id={topic.id} value={topic.id} ref={selectedTopicId === topic.id ? selectedRef : undefined}>
                  {topic.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
      </div>

      {visiblePosts.length > 0 ? (
        <div className="mt-6 sm:mt-8">
          {masonryColumnCounts.map((count) => (
            <div key={count} className="tn-blog-masonry" data-columns={count}>
              {Array.from({ length: count }, (_, column) => (
                <div key={column} className="tn-blog-masonry-column">
                  {visiblePosts.filter((_, index) => index % count === column).map((post) => (
                    <PostCard key={post.slug} post={post} href={`${hrefBase}/${post.slug}`} />
                  ))}
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : (
        <p className="tn-blog-card mt-8 rounded-lg border border-border px-4 py-8 font-sans text-sm text-muted-foreground">
          No recent stories in this topic yet.
        </p>
      )}
    </section>
  );
}

const masonryColumnCounts = [1, 2, 3] as const;

function PostCard({ post, href }: { post: BlogPostCard; href: string }) {
  return (
    <article>
      <Link
        href={href}
        className="tn-blog-card tn-blog-post group flex flex-col overflow-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background"
      >
        <span className="tn-blog-post-image relative block overflow-hidden bg-muted">
          <Image
            src={post.imageUrl}
            alt=""
            fill
            sizes="(max-width: 639px) calc(100vw - 2rem), (max-width: 1023px) 50vw, 21rem"
            className="object-cover transition-transform duration-200 group-hover:scale-[1.015] motion-reduce:transform-none"
          />
        </span>
        <span className="flex flex-col gap-2 p-4 sm:p-5">
          <span className="text-xs font-medium text-muted-foreground">{post.topicLabel}</span>
          <h3 className="font-sans text-lg font-semibold leading-snug tracking-tight text-pretty">{post.title}</h3>
          <span className="text-sm leading-relaxed text-foreground/70">{post.excerpt}</span>
          <time dateTime={post.date} className="pt-1 font-mono text-[13px] text-muted-foreground">{formatBlogPostDate(post.date)}</time>
        </span>
      </Link>
    </article>
  );
}
