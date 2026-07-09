"use client";

import { useEffect, useRef, useState } from "react";
import { Clock } from "lucide-react";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export interface CalendarTimePickerProps {
  /** Value as "HH:MM" (24h). */
  value: string;
  onChange: (value: string) => void;
  className?: string;
  ariaLabel?: string;
  /** Minute step for the scrollable list. Default 30. */
  step?: number;
  /** Render only the clock icon as the trigger (no time label). */
  iconOnly?: boolean;
}

function pad(n: number) {
  return String(n).padStart(2, "0");
}

/** Return the time as 24-hour "HH:MM". */
function formatTimeDisplay(hhmm: string): string {
  const match = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!match) return hhmm;
  return `${match[1]}:${match[2]}`;
}

function buildSlots(step: number): string[] {
  const slots: string[] = [];
  for (let mins = 0; mins < 24 * 60; mins += step) {
    slots.push(`${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`);
  }
  return slots;
}

export function CalendarTimePicker({
  value,
  onChange,
  className,
  ariaLabel = "Pick a time",
  step = 30,
  iconOnly = false,
}: CalendarTimePickerProps) {
  const [open, setOpen] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const slots = buildSlots(step);

  // Scroll the selected slot into view when the popover opens.
  useEffect(() => {
    if (!open) return;
    const id = setTimeout(() => {
      const el = listRef.current?.querySelector<HTMLElement>(
        `[data-selected="true"]`
      );
      el?.scrollIntoView({ block: "center" });
    }, 0);
    return () => clearTimeout(id);
  }, [open]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={ariaLabel}
        className={cn(
          iconOnly
            ? "inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-input bg-transparent text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            : "flex h-7 items-center gap-2 rounded-md border border-input bg-transparent px-2 text-xs text-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
          className
        )}
      >
        <Clock className={iconOnly ? "size-3.5" : "size-3.5 opacity-70"} />
        {!iconOnly && (
          <span className="tabular-nums">{formatTimeDisplay(value)}</span>
        )}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-36 p-1">
        <div
          ref={listRef}
          className="flex max-h-60 flex-col overflow-y-auto scrollbar-none"
          role="listbox"
        >
          {slots.map((slot) => {
            const selected = slot === value;
            return (
              <button
                key={slot}
                type="button"
                role="option"
                aria-selected={selected}
                data-selected={selected}
                onClick={() => {
                  onChange(slot);
                  setOpen(false);
                }}
                className={cn(
                  "flex h-7 shrink-0 items-center rounded px-2 text-[11px] tabular-nums transition-colors outline-none",
                  "focus-visible:bg-accent",
                  selected
                    ? "bg-foreground text-background font-medium"
                    : "text-foreground hover:bg-accent"
                )}
              >
                {formatTimeDisplay(slot)}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
