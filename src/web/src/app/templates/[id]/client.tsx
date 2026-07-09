"use client";

import Link from "next/link";
import { Check } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { PublicLayout } from "@/components/public-layout";
import { MemberCard } from "./_components/member-card";
import type { TemplatePreset } from "@/lib/templates";

const ROLE_LABELS: Record<string, string> = {
  leader: "Leader",
  researcher: "Researcher",
  engineer: "Engineer",
  assistant: "Assistant",
};

export function TemplateDetailClient({
  template,
  isLoggedIn,
  workspaceId,
}: {
  template: TemplatePreset;
  isLoggedIn: boolean;
  workspaceId?: string;
}) {
  const getUrl = workspaceId
    ? `/studio/new?template=${template.id}&workspace_id=${workspaceId}`
    : `/studio/new?template=${template.id}`;
  const href = isLoggedIn
    ? getUrl
    : `/sign-in?redirect=${encodeURIComponent(getUrl)}`;

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
      <div className="mx-auto max-w-4xl px-6 py-10">
        {/* Breadcrumb */}
        <nav className="mb-8 flex items-center gap-2 text-xs text-muted-foreground">
          <Link href="/templates" className="hover:text-foreground transition-colors">
            Templates
          </Link>
          <span className="text-muted-foreground/50">/</span>
          <span className="text-foreground">{template.name}</span>
        </nav>

        {/* Hero */}
        <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex-1 max-w-2xl">
            <div className="flex items-center gap-4">
              <span className="flex size-14 items-center justify-center rounded-xl bg-muted/60 text-3xl">
                {template.icon}
              </span>
              <div>
                <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  {template.category}
                </p>
                <h1
                  className="mt-1 text-2xl font-semibold tracking-tight"
                  style={{ fontFamily: "var(--font-news)" }}
                >
                  {template.name}
                </h1>
              </div>
            </div>
            <p className="mt-4 text-sm leading-relaxed text-muted-foreground max-w-xl">
              {template.longDescription}
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              {template.tags.map((tag) => (
                <span key={tag} className="rounded-full bg-muted/60 px-2 py-1 text-xs text-muted-foreground">
                  {tag}
                </span>
              ))}
            </div>
          </div>

          {/* CTA */}
          <div className="shrink-0 sm:ml-8 sm:pt-2">
            <Link href={href} className={buttonVariants({ size: "default" }) + " w-full sm:w-auto"}>
              Use This Template
            </Link>
            <p className="mt-2 text-center text-xs text-muted-foreground sm:text-right">
              Free to deploy
            </p>
          </div>
        </div>

        {/* Divider */}
        <div className="my-10 border-t" />

        {/* Features */}
        <section className="max-w-2xl">
          <h2 className="text-base font-semibold tracking-tight">What it does</h2>
          <ul className="mt-4 space-y-2">
            {template.features.map((feature) => (
              <li key={feature} className="flex items-start gap-2 text-sm text-foreground/80">
                <Check className="mt-1 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" strokeWidth={2.5} />
                <span>{feature}</span>
              </li>
            ))}
          </ul>
        </section>

        {/* Use Cases */}
        <section className="mt-12 max-w-2xl">
          <h2 className="text-base font-semibold tracking-tight">Use cases</h2>
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {template.useCases.map((uc) => (
              <div key={uc.title} className="rounded-lg bg-muted/40 p-4">
                <h3 className="text-sm font-medium">{uc.title}</h3>
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  {uc.description}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* Company */}
        <section className="mt-12 max-w-2xl">
          <h2 className="text-base font-semibold tracking-tight">Your company</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {template.members.length} agents working together.
          </p>
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {template.members.map((member, i) => (
              <MemberCard
                key={i}
                role={member.role}
                roleLabel={ROLE_LABELS[member.role] || member.role}
                description={member.description}
              />
            ))}
          </div>
        </section>

        {/* Bottom CTA */}
        <div className="mt-16 flex items-center justify-between rounded-xl bg-muted/40 p-6">
          <div>
            <p className="text-sm font-medium">Ready to deploy?</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Customize the agent instructions after setup.
            </p>
          </div>
          <Link href={href} className={buttonVariants({ size: "sm" })}>
            Get Started
          </Link>
        </div>
      </div>
    </PublicLayout>
  );
}
