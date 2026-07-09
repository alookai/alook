"use client";

import { cn } from "@/lib/utils";

export type CalendarView = "month" | "week" | "agenda";

export function parseCalendarView(raw: string | null | undefined): CalendarView {
  if (raw === "week") return "week";
  if (raw === "agenda") return "agenda";
  return "month";
}

export interface CalendarViewSwitcherProps {
  view: CalendarView;
  onChange: (view: CalendarView) => void;
}

export function CalendarViewSwitcher({ view, onChange }: CalendarViewSwitcherProps) {
  return (
    <div
      role="radiogroup"
      aria-label="Calendar view"
      className="inline-flex items-center rounded-md border border-border bg-background p-1"
    >
      {(["month", "week", "agenda"] as const).map((v) => {
        const active = view === v;
        return (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(v)}
            className={cn(
              "h-6 px-2 rounded text-xs font-medium transition-colors capitalize",
              active
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {v}
          </button>
        );
      })}
    </div>
  );
}
