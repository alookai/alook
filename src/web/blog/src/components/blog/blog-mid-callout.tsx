"use client";

import { useCallback, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { ArrowRight } from "@/components/icons/lucide";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { GeneratedAvatar } from "@/components/avatar/generated-avatar";
import technostalgia from "@/components/brand/technostalgia.module.css";
import { cn } from "@/lib/utils";
import { BlogCtaLink } from "./blog-cta-link";
import { buildBlogSignInHref, type BlogConversionCopy } from "@blog/lib/blog/conversion-copy";

function createHostSlot() {
  let current: HTMLDivElement | null = null;
  return {
    get: () => current,
    set: (next: HTMLDivElement | null) => {
      current = next;
    },
  };
}

export function BlogMidCallout({
  copy,
  headingCount,
}: {
  copy: BlogConversionCopy["mid"];
  headingCount?: number;
}) {
  const [hostSlot] = useState(createHostSlot);
  const subscribe = useCallback((onStoreChange: () => void) => {
    if (typeof headingCount === "number" && headingCount > 0 && headingCount < 4) return () => {};
    const prose = document.querySelector("[data-blog-prose]");
    if (!prose) return () => {};
    const headings = prose.querySelectorAll("h2");
    if (headings.length < 4) return () => {};

    const target = headings[2];
    if (!target || !target.parentNode) return () => {};

    const container = document.createElement("div");
    container.setAttribute("data-blog-callout", "");
    container.className = "my-9";
    target.parentNode.insertBefore(container, target);
    hostSlot.set(container);
    onStoreChange();

    return () => {
      container.remove();
      hostSlot.set(null);
      onStoreChange();
    };
  }, [headingCount, hostSlot]);
  const host = useSyncExternalStore(subscribe, hostSlot.get, () => null);

  if (!host) return null;

  return createPortal(
    <aside
      aria-label="Try Alook"
      data-testid="blog-mid-callout"
      className={technostalgia.theme}
    >
      <Card surface="sticker" className="gap-0 px-6 py-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2.5">
              <div className="flex items-center -space-x-2" aria-hidden="true">
                <GeneratedAvatar seed="claude" size={28} className="rounded-full ring-2 ring-(--tn-sticker-face)" />
                <GeneratedAvatar seed="codex" size={28} className="rounded-full ring-2 ring-(--tn-sticker-face)" />
              </div>
              <Badge variant="secondary" className="h-auto px-2.5 py-0.5 text-xs" style={{ rotate: "-2deg" }}>
                {copy.eyebrow}
              </Badge>
            </div>
            <p className="mt-2.5 font-sans text-base font-semibold leading-snug tracking-tight text-foreground">
              {copy.headline}
            </p>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              {copy.body}
            </p>
          </div>

          <div className="shrink-0">
            <BlogCtaLink
              href={buildBlogSignInHref("blog-mid")}
              ctaName="blog_mid_get_started"
              data-variant="default"
              data-size="default"
              className={cn(buttonVariants({ size: "default" }), "h-9 gap-2 px-4 text-sm whitespace-nowrap")}
            >
              {copy.ctaLabel}
              <ArrowRight size={14} />
            </BlogCtaLink>
          </div>
        </div>
      </Card>
    </aside>,
    host,
  );
}
