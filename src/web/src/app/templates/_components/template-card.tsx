"use client";

import Link from "next/link";
import type { TemplatePreset } from "@/lib/templates";

const ROLE_DOT_COLORS: Record<string, string> = {
  leader: "bg-amber-500/70 dark:bg-amber-400/60",
  researcher: "bg-sky-500/70 dark:bg-sky-400/60",
  engineer: "bg-emerald-500/70 dark:bg-emerald-400/60",
  assistant: "bg-violet-500/70 dark:bg-violet-400/60",
};

export function TemplateCard({
  template,
}: {
  template: TemplatePreset;
}) {
  return (
    <Link
      href={`/templates/${template.id}`}
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

      </div>
    </Link>
  );
}
