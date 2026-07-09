"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { PublicLayout } from "@/components/public-layout";
import { TemplateCard } from "./_components/template-card";
import type { TemplatePreset, TemplateCategory } from "@/lib/templates";
import { trackTemplatesBrowsed } from "@/lib/analytics";

export function TemplatesClient({
  templates,
  categories,
  isLoggedIn,
  workspaceId,
}: {
  templates: TemplatePreset[];
  categories: TemplateCategory[];
  isLoggedIn: boolean;
  workspaceId?: string;
}) {
  const [activeCategory, setActiveCategory] = useState<"All" | TemplateCategory>("All");
  const tracked = useRef(false);

  useEffect(() => {
    if (!tracked.current) {
      tracked.current = true;
      trackTemplatesBrowsed({ category_filter: "All" });
    }
  }, []);

  const handleCategoryChange = (cat: "All" | TemplateCategory) => {
    setActiveCategory(cat);
    trackTemplatesBrowsed({ category_filter: cat });
  };

  const filtered =
    activeCategory === "All"
      ? templates
      : templates.filter((t) => t.category === activeCategory);

  return (
    <PublicLayout
      maxWidth="4xl"
      rightSlot={
        <>
          <Link
            href="/templates"
            className="hidden sm:block px-3 py-2 text-xs uppercase tracking-widest font-mono transition-opacity hover:opacity-70"
          >
            Templates
          </Link>
          <Link
            href="/blog"
            className="hidden sm:block px-3 py-2 text-xs uppercase tracking-widest font-mono transition-opacity hover:opacity-70"
          >
            Blog
          </Link>
          {isLoggedIn ? (
            <Link
              href="/workspaces?auto"
              className="inline-flex items-center gap-2 px-4 py-2 text-xs uppercase tracking-widest font-mono border border-current transition-opacity hover:opacity-70"
            >
              App
            </Link>
          ) : (
            <Link
              href="/sign-in"
              className="inline-flex items-center gap-2 px-4 py-2 text-xs uppercase tracking-widest font-mono bg-foreground text-background transition-opacity hover:opacity-70"
            >
              Get Started
            </Link>
          )}
        </>
      }
    >
      {/* Header */}
      <div className="mx-auto max-w-4xl px-6 pt-16 pb-2">
        <h1
          className="text-3xl font-semibold tracking-tight"
          style={{ fontFamily: "var(--font-news)" }}
        >
          Start your company
        </h1>
        <p className="mt-3 max-w-lg text-sm leading-relaxed text-muted-foreground">
          Pre-configured AI companies, ready to work. Choose a template, make it yours, and deploy in minutes.
        </p>
      </div>

      {/* Category Filter */}
      <div className="mx-auto max-w-4xl px-6 pt-8 pb-6">
        <div className="flex flex-wrap gap-2">
          {["All", ...categories].map((cat) => (
            <button
              key={cat}
              onClick={() => handleCategoryChange(cat as "All" | TemplateCategory)}
              className={`rounded-full px-4 py-2 text-xs font-medium transition-colors duration-150 ${
                activeCategory === cat
                  ? "bg-foreground text-background"
                  : "bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      {/* Grid */}
      <div className="mx-auto max-w-4xl px-6 pb-20">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {filtered.map((template) => (
            <TemplateCard
              key={template.id}
              template={template}
              isLoggedIn={isLoggedIn}
              workspaceId={workspaceId}
            />
          ))}
        </div>
        {filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20">
            <p className="text-sm text-muted-foreground">
              No templates in this category yet.
            </p>
          </div>
        )}
      </div>
    </PublicLayout>
  );
}
