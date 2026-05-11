"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Users } from "lucide-react";
import type { TemplatePreset } from "@/lib/templates";

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
      className="group flex flex-col rounded-lg border bg-card p-4 transition-colors hover:bg-accent/50"
    >
      {/* Icon + Category */}
      <div className="flex items-start justify-between">
        <span className="flex size-9 items-center justify-center rounded-md bg-muted text-lg">
          {template.icon}
        </span>
        <Badge variant="outline" className="text-[10px]">
          {template.category}
        </Badge>
      </div>

      {/* Name + Description */}
      <h3 className="mt-3 text-sm font-semibold leading-tight">
        {template.name}
      </h3>
      <p className="mt-1.5 flex-1 text-xs leading-relaxed text-muted-foreground line-clamp-2">
        {template.description}
      </p>

      {/* Footer */}
      <div className="mt-3 flex items-center justify-between">
        <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <Users className="size-3" />
          {template.members.length} {template.members.length === 1 ? "agent" : "agents"}
        </span>
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            router.push(href);
          }}
          className="rounded-md bg-foreground px-2.5 py-1 text-[11px] font-medium text-background transition-opacity hover:opacity-80"
        >
          Get
        </button>
      </div>
    </Link>
  );
}
