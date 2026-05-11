"use client";

import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { ArrowLeft } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { TemplateCard } from "./_components/template-card";
import type { TemplatePreset, TemplateCategory } from "@/lib/templates";

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

  const filtered =
    activeCategory === "All"
      ? templates
      : templates.filter((t) => t.category === activeCategory);

  return (
    <div className="min-h-dvh bg-background">
      {/* Nav */}
      <nav className="sticky top-0 z-50 border-b bg-background/90 backdrop-blur-sm">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-3">
          <Link href="/" className="flex items-center gap-2">
            <Image src="/alook.svg" alt="Alook" width={22} height={22} />
            <span className="text-lg tracking-tight" style={{ fontFamily: "var(--font-brand)", fontWeight: 700 }}>Alook</span>
          </Link>
          <div className="flex items-center gap-2">
            {isLoggedIn ? (
              <Link href="/workspaces?auto" className={buttonVariants({ variant: "outline", size: "sm" })}>
                <ArrowLeft className="mr-1.5 size-3" />
                Back to App
              </Link>
            ) : (
              <Link href="/sign-in" className={buttonVariants({ size: "sm" })}>
                Sign In
              </Link>
            )}
          </div>
        </div>
      </nav>

      {/* Header */}
      <div className="mx-auto max-w-5xl px-6 pt-12 pb-8">
        <h1 className="text-2xl font-bold tracking-tight">Templates</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Pre-built AI teams ready to deploy. Pick a template, customize it, and start working in minutes.
        </p>
      </div>

      {/* Category Tabs */}
      <div className="mx-auto max-w-5xl px-6 pb-6">
        <div className="flex gap-1 overflow-x-auto border-b">
          {["All", ...categories].map((cat) => (
            <button
              key={cat}
              onClick={() => setActiveCategory(cat as "All" | TemplateCategory)}
              className={`shrink-0 px-3 py-2 text-xs font-medium transition-colors ${
                activeCategory === cat
                  ? "border-b-2 border-foreground text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      {/* Grid */}
      <div className="mx-auto max-w-5xl px-6 pb-16">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
          <p className="py-12 text-center text-sm text-muted-foreground">
            No templates in this category yet.
          </p>
        )}
      </div>
    </div>
  );
}
