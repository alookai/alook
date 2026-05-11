"use client";

import Link from "next/link";
import Image from "next/image";
import { ArrowLeft, Users, CheckCircle2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
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

      <div className="mx-auto max-w-5xl px-6 py-10">
        {/* Breadcrumb */}
        <nav className="mb-6 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Link href="/templates" className="hover:text-foreground transition-colors">
            Templates
          </Link>
          <span>/</span>
          <span className="text-foreground">{template.name}</span>
        </nav>

        {/* Hero */}
        <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex-1 space-y-4">
            <div className="flex items-center gap-3">
              <span className="flex size-12 items-center justify-center rounded-lg bg-muted text-2xl">
                {template.icon}
              </span>
              <div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="text-[10px]">
                    {template.category}
                  </Badge>
                  <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                    <Users className="size-3" />
                    {template.members.length} agents
                  </span>
                </div>
                <h1 className="mt-1 text-xl font-bold tracking-tight">
                  {template.name}
                </h1>
              </div>
            </div>
            <p className="text-sm text-muted-foreground leading-relaxed">
              {template.longDescription}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {template.tags.map((tag) => (
                <Badge key={tag} variant="secondary" className="text-[10px]">
                  {tag}
                </Badge>
              ))}
            </div>
          </div>

          {/* CTA */}
          <div className="shrink-0 lg:ml-8">
            <Link href={href} className={buttonVariants({ size: "default" }) + " w-full lg:w-auto"}>
              Get This Template
            </Link>
            <p className="mt-1.5 text-center text-[10px] text-muted-foreground">
              Free to deploy
            </p>
          </div>
        </div>

        {/* Content Grid */}
        <div className="mt-10 grid grid-cols-1 gap-10 lg:grid-cols-3">
          {/* Left: Features + Use Cases */}
          <div className="lg:col-span-2 space-y-8">
            {/* Features */}
            <section>
              <h2 className="text-sm font-semibold mb-3">Key Features</h2>
              <ul className="space-y-2">
                {template.features.map((feature) => (
                  <li key={feature} className="flex items-start gap-2 text-xs text-muted-foreground">
                    <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-600" />
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>
            </section>

            {/* Use Cases */}
            <section>
              <h2 className="text-sm font-semibold mb-3">Use Cases</h2>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {template.useCases.map((uc) => (
                  <div key={uc.title} className="rounded-lg border p-3">
                    <h3 className="text-xs font-medium">{uc.title}</h3>
                    <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                      {uc.description}
                    </p>
                  </div>
                ))}
              </div>
            </section>

            {/* Team */}
            <section>
              <h2 className="text-sm font-semibold mb-3">Your AI Team</h2>
              <p className="mb-4 text-xs text-muted-foreground">
                These {template.members.length} agents work together to run your {template.name.toLowerCase()}.
              </p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
          </div>

          {/* Right Sidebar */}
          <div className="space-y-6">
            <div className="rounded-lg border p-4 space-y-4">
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Category</p>
                <p className="text-xs font-medium mt-0.5">{template.category}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Team Size</p>
                <p className="text-xs font-medium mt-0.5">{template.members.length} agents</p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Roles</p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {template.members.map((m, i) => (
                    <Badge key={i} variant="outline" className="text-[10px]">
                      {ROLE_LABELS[m.role] || m.role}
                    </Badge>
                  ))}
                </div>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Tags</p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {template.tags.map((tag) => (
                    <Badge key={tag} variant="secondary" className="text-[10px]">
                      {tag}
                    </Badge>
                  ))}
                </div>
              </div>
            </div>

          </div>
        </div>
      </div>
    </div>
  );
}
