"use client";

import { cn } from "@/lib/utils";
import type { Agent } from "@alook/shared";
import { Skeleton } from "@/components/ui/skeleton";
import { agentColor } from "./calendar-month-grid";

export interface CalendarAgentFilterProps {
  agents: Agent[];
  selected: Set<string>;
  onToggle: (agentId: string) => void;
}

/**
 * Chip row height is pinned (`h-6` + flex container) so the filter reserves the
 * same vertical space whether loading, empty, or populated — avoids layout
 * drift that would push the calendar grid down on load.
 */
export function CalendarAgentFilter({
  agents,
  selected,
  onToggle,
}: CalendarAgentFilterProps) {
  return (
    <div className="flex min-h-6 items-center gap-2 overflow-x-auto flex-nowrap scrollbar-none sm:flex-wrap sm:overflow-x-visible">
      {agents.length === 0 ? (
        <>
          <Skeleton className="h-6 w-20 rounded-full" />
          <Skeleton className="h-6 w-24 rounded-full" />
          <Skeleton className="h-6 w-16 rounded-full" />
        </>
      ) : (
        agents.map((a) => {
          const on = selected.has(a.id);
          return (
            <button
              type="button"
              key={a.id}
              onClick={() => onToggle(a.id)}
              className={cn(
                "flex h-6 shrink-0 items-center gap-2 rounded-full px-2 text-[11px] font-medium transition-colors",
                on
                  ? "bg-foreground text-background"
                  : "bg-transparent text-muted-foreground border border-border hover:bg-accent"
              )}
            >
              <span
                className={cn("size-2 rounded-full", agentColor(a.id).split(" ")[0])}
              />
              <span className="max-w-30 truncate sm:max-w-none">{a.name}</span>
            </button>
          );
        })
      )}
    </div>
  );
}
