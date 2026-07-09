"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import type { TemplatePreset } from "@/lib/templates";
import { trackTemplateUsed } from "@/lib/analytics";

const ROLE_DOT_COLORS: Record<string, string> = {
  leader: "bg-amber-500/70 dark:bg-amber-400/60",
  researcher: "bg-sky-500/70 dark:bg-sky-400/60",
  engineer: "bg-emerald-500/70 dark:bg-emerald-400/60",
  assistant: "bg-violet-500/70 dark:bg-violet-400/60",
};

export function TemplateCard({
  template,
  isLoggedIn,
  workspaceId,
}: {
  template: TemplatePreset;
  isLoggedIn: boolean;
  workspaceId?: string;
}) {
  const router = useRouter();
  const getUrl = workspaceId
    ? `/studio/new?template=${template.id}&workspace_id=${workspaceId}`
    : `/studio/new?template=${template.id}`;
  const href = isLoggedIn
    ? getUrl
    : `/sign-in?redirect=${encodeURIComponent(getUrl)}`;

  const detailUrl = workspaceId
    ? `/templates/${template.id}?workspace_id=${workspaceId}`
    : `/templates/${template.id}`;

  return (
    <Link
      href={detailUrl}
      className="group relative flex flex-col rounded-xl bg-card p-4 transition-all duration-200 hover:bg-accent/40 border border-transparent hover:border-border"
    >
      {/* Icon */}
      <span className="flex size-10 items-center justify-center rounded-lg bg-muted/60 text-xl">
        {template.icon}
      </span>

      {/* Name */}
      <h3 className="mt-4 text-sm font-semibold leading-tight tracking-tight">
        {template.name}
      </h3>

      {/* Description */}
      <p className="mt-2 flex-1 text-xs leading-relaxed text-muted-foreground line-clamp-2">
        {template.description}
      </p>

      {/* Footer */}
      <div className="mt-4 flex items-center justify-between">
        <div className="flex items-center gap-1">
          {template.members.map((member, i) => (
            <span
              key={i}
              className={`size-2 rounded-full ${ROLE_DOT_COLORS[member.role] || "bg-muted-foreground/40"}`}
            />
          ))}
          <span className="ml-2 text-xs text-muted-foreground">
            {template.members.length} agents
          </span>
        </div>

        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            trackTemplateUsed({ template_id: template.id, template_name: template.name });
            router.push(href);
          }}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground opacity-0 transition-all duration-150 group-hover:opacity-100 group-hover:bg-foreground group-hover:text-background"
        >
          Use
          <ArrowUpRight className="size-3" />
        </button>
      </div>
    </Link>
  );
}
