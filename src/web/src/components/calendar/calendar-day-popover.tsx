"use client";

import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { CalendarEvent, Agent } from "@alook/shared";
import { Repeat } from "lucide-react";
import { agentDot, agentInk } from "./calendar-month-grid";

export interface CalendarDayPopoverProps {
  events: CalendarEvent[];
  agents: Agent[];
  date: Date;
  hiddenCount: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectEvent: (event: CalendarEvent) => void;
}

function timeLabel(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function CalendarDayPopover({
  events,
  agents,
  date,
  hiddenCount,
  open,
  onOpenChange,
  onSelectEvent,
}: CalendarDayPopoverProps) {
  const agentNameById = new Map<string, string>();
  for (const a of agents) agentNameById.set(a.id, a.name);

  const sorted = [...events].sort(
    (a, b) =>
      new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime()
  );

  const dateLabel = date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        aria-label={`${hiddenCount} more event${hiddenCount === 1 ? "" : "s"}`}
        onClick={(e) => e.stopPropagation()}
        className="w-full truncate rounded-sm px-2 py-1 text-left text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
      >
        +{hiddenCount} more
      </PopoverTrigger>
      <PopoverContent className="w-64" align="start">
        <div className="flex flex-col gap-2">
          <p className="px-1 pb-1 text-[11px] font-medium text-muted-foreground">
            {dateLabel}
          </p>
          <div className="flex flex-col gap-1">
            {sorted.map((ev) => {
              const isRecurring = Boolean(ev.repeat_interval);
              return (
                <button
                  key={`${ev.id}@${ev.occurrence_at}`}
                  type="button"
                  onClick={() => {
                    onOpenChange(false);
                    onSelectEvent(ev);
                  }}
                  className="flex items-center gap-2 rounded-sm px-2 py-1 text-left text-[11px] font-medium text-foreground/85 hover:bg-accent/60 transition-colors"
                  title={`${isRecurring ? "Recurring · " : ""}${ev.title}${
                    agentNameById.get(ev.agent_id)
                      ? ` — ${agentNameById.get(ev.agent_id)}`
                      : ""
                  }`}
                >
                  {isRecurring ? (
                    <Repeat
                      aria-hidden
                      className={cn("size-3 shrink-0", agentInk(ev.agent_id))}
                    />
                  ) : (
                    <span
                      aria-hidden
                      className={cn(
                        "size-1.5 shrink-0 rounded-full",
                        agentDot(ev.agent_id)
                      )}
                    />
                  )}
                  <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
                    {timeLabel(ev.scheduled_at)}
                  </span>
                  <span className="truncate">{ev.title}</span>
                </button>
              );
            })}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
