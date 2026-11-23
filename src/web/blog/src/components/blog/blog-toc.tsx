"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { ArrowRight, Check, Copy } from "@/components/icons/lucide";
import { GeneratedAvatar } from "@/components/avatar/generated-avatar";
import { Button, buttonVariants } from "@/components/ui/button";
import technostalgia from "@/components/brand/technostalgia.module.css";
import { cn } from "@/lib/utils";
import type { BlogHeading } from "@blog/lib/blog/headings";
import { buildBlogSignInHref } from "@blog/lib/blog/conversion-copy";
import { BlogCtaLink } from "./blog-cta-link";

type IndicatorMetrics = {
  top: number;
  height: number;
  dotTop: number;
  ready: boolean;
  animate: boolean;
};

export function BlogToc({
  headings,
  title,
  slug,
}: {
  headings: readonly BlogHeading[];
  title: string;
  slug: string;
}) {
  const [resolvedHeadings, setResolvedHeadings] = useState<readonly BlogHeading[]>(headings);
  const [activeId, setActiveId] = useState<string>(headings[0]?.id ?? "");
  const [copied, setCopied] = useState(false);
  const [indicator, setIndicator] = useState<IndicatorMetrics>({
    top: 0,
    height: 0,
    dotTop: 0,
    ready: false,
    animate: false,
  });

  const listRef = useRef<HTMLUListElement | null>(null);
  const linkRefs = useRef<Record<string, HTMLAnchorElement | null>>({});
  const activeIdRef = useRef(activeId);
  const paintedSlugRef = useRef<string | null>(null);
  const clickScrollLockRef = useRef(false);
  const clickScrollSettleTimerRef = useRef<number | null>(null);
  const clickScrollMaxTimerRef = useRef<number | null>(null);

  const releaseClickScrollLock = useCallback(() => {
    clickScrollLockRef.current = false;
    if (clickScrollSettleTimerRef.current !== null) {
      window.clearTimeout(clickScrollSettleTimerRef.current);
      clickScrollSettleTimerRef.current = null;
    }
    if (clickScrollMaxTimerRef.current !== null) {
      window.clearTimeout(clickScrollMaxTimerRef.current);
      clickScrollMaxTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (headings.length > 0) {
      setResolvedHeadings(headings);
      setActiveId(headings[0].id);
      return;
    }
    const prose = document.querySelector("[data-blog-prose]");
    if (!prose) return;
    const discovered = [...prose.querySelectorAll("h2[id]")]
      .map((el) => ({ id: el.id, text: (el.textContent ?? "").trim() }))
      .filter((item) => item.id && item.text);
    if (discovered.length > 0) {
      setResolvedHeadings(discovered);
      setActiveId(discovered[0].id);
    }
  }, [headings]);

  const measureIndicator = useCallback((id: string, allowAnimate: boolean) => {
    const list = listRef.current;
    const link = linkRefs.current[id];
    if (!list || !link) return;
    const listRect = list.getBoundingClientRect();
    const linkRect = link.getBoundingClientRect();
    const top = Math.round(linkRect.top - listRect.top);
    const height = Math.round(linkRect.height);
    const dotTop = top + Math.round(height / 2) - 3;
    setIndicator({
      top,
      height,
      dotTop,
      ready: true,
      animate: allowAnimate,
    });
  }, []);

  useLayoutEffect(() => {
    activeIdRef.current = activeId;
    if (!activeId) return;
    const animate = paintedSlugRef.current === slug;
    measureIndicator(activeId, animate);
    if (linkRefs.current[activeId]) {
      paintedSlugRef.current = slug;
    }
  }, [activeId, resolvedHeadings, slug, measureIndicator]);

  useEffect(() => {
    return () => {
      releaseClickScrollLock();
    };
  }, [releaseClickScrollLock]);

  useEffect(() => {
    const list = listRef.current;
    if (!list || typeof ResizeObserver === "undefined") return;
    let initial = true;
    const ro = new ResizeObserver(() => {
      if (initial) {
        initial = false;
        return;
      }
      if (activeIdRef.current) measureIndicator(activeIdRef.current, false);
    });
    ro.observe(list);
    return () => ro.disconnect();
  }, [measureIndicator]);

  useEffect(() => {
    if (resolvedHeadings.length === 0 || typeof window === "undefined") return;

    const ENTER_LINE = 112;
    const EXIT_LINE = 136;

    let frame: number | null = null;
    const syncActiveFromScroll = () => {
      frame = null;
      if (clickScrollLockRef.current) {
        if (clickScrollSettleTimerRef.current !== null) {
          window.clearTimeout(clickScrollSettleTimerRef.current);
        }
        clickScrollSettleTimerRef.current = window.setTimeout(releaseClickScrollLock, 140);
        return;
      }
      const nearBottom = document.documentElement.scrollHeight - (window.scrollY + window.innerHeight) <= 24;
      if (nearBottom) {
        setActiveId(resolvedHeadings[resolvedHeadings.length - 1].id);
        return;
      }

      const prevIndex = resolvedHeadings.findIndex((h) => h.id === activeIdRef.current);
      let nextIndex = 0;
      for (let i = 0; i < resolvedHeadings.length; i++) {
        const el = document.getElementById(resolvedHeadings[i].id);
        if (!el) continue;
        const threshold = prevIndex !== -1 && i <= prevIndex ? EXIT_LINE : ENTER_LINE;
        if (el.getBoundingClientRect().top <= threshold) {
          nextIndex = i;
        } else {
          break;
        }
      }
      setActiveId(resolvedHeadings[nextIndex].id);
    };

    const scheduleSync = () => {
      if (frame === null) {
        frame = window.requestAnimationFrame(syncActiveFromScroll);
      }
    };

    const handleScrollEnd = () => {
      if (clickScrollLockRef.current) {
        releaseClickScrollLock();
      }
    };

    const handleUserInterrupt = () => {
      if (clickScrollLockRef.current) {
        releaseClickScrollLock();
      }
    };

    syncActiveFromScroll();
    window.addEventListener("scroll", scheduleSync, { passive: true });
    window.addEventListener("resize", scheduleSync, { passive: true });
    window.addEventListener("scrollend", handleScrollEnd, { passive: true });
    window.addEventListener("wheel", handleUserInterrupt, { passive: true });
    window.addEventListener("touchstart", handleUserInterrupt, { passive: true });
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", scheduleSync);
      window.removeEventListener("resize", scheduleSync);
      window.removeEventListener("scrollend", handleScrollEnd);
      window.removeEventListener("wheel", handleUserInterrupt);
      window.removeEventListener("touchstart", handleUserInterrupt);
    };
  }, [resolvedHeadings, releaseClickScrollLock]);

  const handleHeadingClick = (event: MouseEvent<HTMLAnchorElement>, id: string) => {
    const target = document.getElementById(id);
    if (!target) return;
    event.preventDefault();
    releaseClickScrollLock();
    clickScrollLockRef.current = true;
    clickScrollSettleTimerRef.current = window.setTimeout(releaseClickScrollLock, 180);
    clickScrollMaxTimerRef.current = window.setTimeout(releaseClickScrollLock, 1800);
    setActiveId(id);
    const reduced = typeof window !== "undefined"
      && typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const targetTop = Math.max(0, Math.round(target.getBoundingClientRect().top + window.scrollY - 88));
    window.scrollTo({ top: targetTop, behavior: reduced ? "auto" : "smooth" });
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", `#${id}`);
    }
  };

  const handleCopy = async () => {
    const shareUrl = typeof window !== "undefined"
      ? window.location.href.split("#")[0]
      : `https://alook.ai/blog/${slug}`;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {}
  };

  const activeIndex = Math.max(
    0,
    resolvedHeadings.findIndex((item) => item.id === activeId),
  );
  const shareHref = `https://x.com/intent/tweet?text=${encodeURIComponent(title)}&url=${encodeURIComponent(`https://alook.ai/blog/${slug}`)}`;

  return (
    <div className="px-1 py-0.5">
      {resolvedHeadings.length > 0 && (
        <nav aria-label="Table of contents" data-testid="blog-toc">
          <div className="flex items-center justify-between gap-2">
            <p className="font-mono text-xs text-muted-foreground">
              Contents
            </p>
            <span className="font-mono text-[11px] tabular-nums text-muted-foreground/80">
              {activeIndex + 1} / {resolvedHeadings.length}
            </span>
          </div>

          <ul
            ref={listRef}
            className="relative mt-2.5 space-y-0.5 border-l border-border pl-2 text-[13px] leading-snug"
          >
            <span
              aria-hidden="true"
              data-testid="blog-toc-indicator"
              data-animate={indicator.animate ? "true" : "false"}
              className="tn-blog-toc-indicator"
              style={{
                top: 0,
                height: indicator.height,
                transform: `translateY(${indicator.top}px)`,
                opacity: indicator.ready ? 1 : 0,
              }}
            />
            <span
              aria-hidden="true"
              data-animate={indicator.animate ? "true" : "false"}
              className="tn-blog-toc-dot"
              style={{
                top: 0,
                transform: `translateY(${indicator.dotTop}px)`,
                opacity: indicator.ready ? 1 : 0,
              }}
            />

            {resolvedHeadings.map((heading) => {
              const isActive = activeId === heading.id;
              return (
                <li key={heading.id} className="relative">
                  <a
                    ref={(el) => {
                      linkRefs.current[heading.id] = el;
                    }}
                    href={`#${heading.id}`}
                    aria-current={isActive ? "location" : undefined}
                    onClick={(event) => handleHeadingClick(event, heading.id)}
                    className={cn(
                      "tn-blog-toc-link block rounded-[10px] px-2.5 py-1.5",
                      isActive
                        ? "font-medium text-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {heading.text}
                  </a>
                </li>
              );
            })}
          </ul>
        </nav>
      )}

      <div
        className={cn(
          technostalgia.theme,
          resolvedHeadings.length > 0 && "mt-5 border-t border-dashed border-border pt-4",
        )}
      >
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={handleCopy}
            data-testid="blog-share-copy"
            className="h-8 flex-1 gap-1.5 text-xs"
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
            <span>{copied ? "Copied" : "Copy link"}</span>
          </Button>
          <a
            href={shareHref}
            target="_blank"
            rel="noopener noreferrer"
            data-variant="secondary"
            data-size="sm"
            data-testid="blog-share-x"
            className={cn(buttonVariants({ variant: "secondary", size: "sm" }), "h-8 flex-1 gap-1.5 text-xs")}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
            </svg>
            <span>Post</span>
          </a>
        </div>

        <div className="group/try relative mt-5">
          <div
            aria-hidden="true"
            data-testid="blog-try-alook-bots"
            className="pointer-events-none absolute -top-3 right-3 z-10 flex items-center -space-x-1"
          >
            <GeneratedAvatar
              seed="alli"
              size={22}
              className="tn-blog-bot-perch rounded-full ring-2 ring-(--tn-paper)"
            />
            <GeneratedAvatar
              seed="cecilia"
              size={22}
              className="tn-blog-bot-perch rounded-full ring-2 ring-(--tn-paper)"
            />
            <GeneratedAvatar
              seed="madox"
              size={22}
              className="tn-blog-bot-perch rounded-full ring-2 ring-(--tn-paper)"
            />
          </div>
          <BlogCtaLink
            href={buildBlogSignInHref("blog-sidebar")}
            ctaName="blog_sidebar_get_started"
            data-variant="default"
            data-size="default"
            data-testid="blog-sidebar-try-alook"
            className={cn(buttonVariants({ size: "default" }), "h-10 w-full justify-center gap-2 text-sm")}
          >
            Try Alook
            <ArrowRight size={14} />
          </BlogCtaLink>
        </div>
      </div>
    </div>
  );
}
