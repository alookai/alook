"use client";

import { useEffect, useMemo, useState, type Ref } from "react";
import Image from "next/image";
import Link from "next/link";
import {
  HorizontalOverflowFadeOverlays,
  useHorizontalOverflowRail,
} from "@/components/horizontal-overflow-rail";
import { useHoverCapable } from "@/hooks/use-hover-capable";
import { useBreakpoint } from "@/hooks/use-mobile";
import type { BlogIndexPost } from "./model";
import { formatBlogPostDate } from "./model";

type BlogTopicFilter = {
  id: string;
  label: string;
};

type RecentPostsProps = {
  posts: readonly BlogIndexPost[];
  topics: readonly BlogTopicFilter[];
};

const allTopicsId = "all";

export function RecentPosts({ posts, topics }: RecentPostsProps) {
  const [selectedTopicId, setSelectedTopicId] = useState(allTopicsId);
  const breakpoint = useBreakpoint();
  const hoverCapable = useHoverCapable();
  const topicIds = useMemo(() => new Set(topics.map((topic) => topic.id)), [topics]);
  const topicKey = useMemo(
    () => topics.map((topic) => `${topic.id}\0${topic.label}`).join("\0"),
    [topics],
  );
  const {
    fades,
    onScroll,
    scrollerRef,
    selectedRef,
  } = useHorizontalOverflowRail<HTMLDivElement, HTMLButtonElement>({
    contentKey: topicKey,
    selectedKey: selectedTopicId,
    mapVerticalWheelToHorizontal:
      breakpoint === "desktop" && hoverCapable,
  });
  const visiblePosts =
    selectedTopicId === allTopicsId
      ? posts
      : posts.filter((post) => post.topicId === selectedTopicId);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const syncTopicFromHash = () => {
      const hashTopicId = decodeURIComponent(window.location.hash.slice(1));
      setSelectedTopicId(topicIds.has(hashTopicId) ? hashTopicId : allTopicsId);
    };

    syncTopicFromHash();
    window.addEventListener("hashchange", syncTopicFromHash);
    return () => window.removeEventListener("hashchange", syncTopicFromHash);
  }, [topicIds]);

  const selectTopic = (topicId: string) => {
    setSelectedTopicId(topicId);
    if (typeof window === "undefined") return;

    const nextUrl =
      topicId === allTopicsId
        ? `${window.location.pathname}${window.location.search}`
        : `${window.location.pathname}${window.location.search}#${topicId}`;
    window.history.replaceState(null, "", nextUrl);
  };

  return (
    <section aria-labelledby="recent-posts-heading" className="mt-12 sm:mt-20">
      <h2
        id="recent-posts-heading"
        className="font-news text-2xl font-semibold tracking-tight sm:text-3xl"
      >
        Recent posts
      </h2>
      <div className="relative mt-3 sm:mt-6">
        <div
          ref={scrollerRef}
          data-testid="blog-topic-scroller"
          onScroll={onScroll}
          className="thin-scrollbar scrollbar-none overflow-x-auto"
        >
          <nav
            aria-label="Filter recent posts"
            className="flex w-max min-w-full flex-nowrap gap-6"
          >
            <TopicButton
              id={allTopicsId}
              label="All"
              selected={selectedTopicId === allTopicsId}
              buttonRef={selectedTopicId === allTopicsId ? selectedRef : undefined}
              onSelect={selectTopic}
            />
            {topics.map((topic) => (
              <TopicButton
                key={topic.id}
                id={topic.id}
                label={topic.label}
                selected={selectedTopicId === topic.id}
                buttonRef={selectedTopicId === topic.id ? selectedRef : undefined}
                onSelect={selectTopic}
              />
            ))}
          </nav>
        </div>
        <HorizontalOverflowFadeOverlays
          fades={fades}
          leftTestId="blog-topic-fade-left"
          rightTestId="blog-topic-fade-right"
        />
      </div>

      {visiblePosts.length > 0 ? (
        <div className="mt-6 grid gap-x-8 gap-y-10 sm:mt-8 sm:grid-cols-3 sm:gap-y-12">
          {visiblePosts.map((post) => (
            <article key={post.slug}>
              <Link
                href={`/blog/${post.slug}`}
                className="group block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background"
              >
                <span className="relative block aspect-video overflow-hidden rounded-lg bg-muted">
                  <Image
                    src={post.imageUrl}
                    alt=""
                    fill
                    sizes="(max-width: 639px) calc(100vw - 2rem), 20.5rem"
                    className="object-cover transition-transform duration-200 group-hover:scale-[1.015] motion-reduce:transform-none"
                  />
                </span>
                <h3 className="mt-4 font-news text-lg font-semibold leading-snug tracking-tight">
                  {post.title}
                </h3>
                <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 font-sans text-sm text-muted-foreground">
                  <span>{post.topicLabel}</span>
                  <span aria-hidden="true">·</span>
                  <time dateTime={post.date}>{formatBlogPostDate(post.date)}</time>
                </span>
              </Link>
            </article>
          ))}
        </div>
      ) : (
        <p className="mt-8 rounded-lg border border-border px-4 py-8 font-sans text-sm text-muted-foreground">
          No recent stories in this topic yet.
        </p>
      )}
    </section>
  );
}

function TopicButton({
  id,
  label,
  selected,
  buttonRef,
  onSelect,
}: {
  id: string;
  label: string;
  selected: boolean;
  buttonRef?: Ref<HTMLButtonElement>;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      ref={buttonRef}
      id={id === allTopicsId ? undefined : id}
      type="button"
      aria-pressed={selected}
      onClick={() => onSelect(id)}
      className={`min-h-11 shrink-0 whitespace-nowrap py-2 font-sans text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
        selected
          ? "font-semibold text-foreground underline decoration-2 underline-offset-4"
          : "font-medium text-muted-foreground hover:text-foreground"
      }`}
    >
      {label}
    </button>
  );
}
