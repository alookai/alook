"use client";

import { cn } from "@/lib/utils";
import type { CalendarEvent, Agent } from "@alook/shared";
import { Skeleton } from "@/components/ui/skeleton";
import { agentColor } from "./calendar-colors";
import { dateKey } from "./calendar-month-grid";
import { formatRepeatDisplay } from "./repeat-interval-utils";

export interface CalendarAgendaProps {
  events: CalendarEvent[];
  agents: Agent[];
  loading: boolean;
  onSelectEvent: (event: CalendarEvent) => void;
}

export function groupByDay(
  events: CalendarEvent[]
): { day: Date; items: CalendarEvent[] }[] {
  const groups = new Map<string, { day: Date; items: CalendarEvent[] }>();
  for (const ev of events) {
    const d = new Date(ev.scheduled_at);
    const key = dateKey(d);
    if (!groups.has(key)) {
      const base = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      groups.set(key, { day: base, items: [] });
    }
    groups.get(key)!.items.push(ev);
  }
  const sorted = [...groups.values()].sort(
    (a, b) => a.day.getTime() - b.day.getTime()
  );
  for (const g of sorted) {
    g.items.sort(
      (a, b) =>
        new Date(a.scheduled_at).getTime() -
        new Date(b.scheduled_at).getTime()
    );
  }
  return sorted;
}

function formatDay(d: Date): string {
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function CalendarAgenda({
  events,
  agents,
  loading,
  onSelectEvent,
}: CalendarAgendaProps) {
  const groups = groupByDay(events);
  const agentNameById = new Map<string, string>();
  for (const a of agents) agentNameById.set(a.id, a.name);
  const today = new Date();

  if (loading && events.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        {Array.from({ length: 4 }).map((_, g) => (
          <div key={g} className="flex flex-col gap-2">
            <Skeleton className="h-3 w-24" />
            {Array.from({ length: 2 }).map((_, r) => (
              <Skeleton key={r} className="h-8 w-full rounded-md" />
            ))}
          </div>
        ))}
      </div>
    );
  }

  if (groups.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center py-12">
        <div className="text-center">
          <p className="text-sm text-muted-foreground">No events in view.</p>
          <p className="mt-2 text-xs text-muted-foreground">
            Switch to month view or create a new event above.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="calendar-agenda">
      {groups.map((g) => {
        const isToday =
          today.getFullYear() === g.day.getFullYear() &&
          today.getMonth() === g.day.getMonth() &&
          today.getDate() === g.day.getDate();
        return (
          <div key={dateKey(g.day)} className="flex flex-col gap-1.5">
            <h3
              className={cn(
                "sticky top-0 z-10 py-1 text-[11px] font-medium text-muted-foreground",
                isToday && "text-foreground"
              )}
            >
              {formatDay(g.day)}
              {isToday && (
                <span className="ml-2 rounded-full bg-foreground text-background px-1.5 py-0.5 text-[10px]">
                  Today
                </span>
              )}
            </h3>
            <ul className="flex flex-col gap-1">
              {g.items.map((ev) => (
                <li key={`${ev.id}@${ev.occurrence_at}`}>
                  <button
                    type="button"
                    onClick={() => onSelectEvent(ev)}
                    className="flex w-full items-center gap-3 rounded-md border border-border/50 bg-background px-3 py-2 text-left transition-colors hover:bg-accent"
                  >
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums w-16">
                      {formatTime(ev.scheduled_at)}
                    </span>
                    <span
                      className={cn(
                        "shrink-0 rounded-sm px-1.5 py-0.5 text-[10px] font-medium",
                        agentColor(ev.agent_id)
                      )}
                    >
                      {agentNameById.get(ev.agent_id) ?? ev.agent_id}
                    </span>
                    <span className="flex-1 truncate text-sm">{ev.title}</span>
                    {ev.repeat_interval && (
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {formatRepeatDisplay(ev.repeat_interval!)}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
