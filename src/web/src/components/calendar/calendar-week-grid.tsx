"use client";

import { useEffect, useRef, useMemo } from "react";
import { cn } from "@/lib/utils";
import type { CalendarEvent, Agent } from "@alook/shared";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { CalendarDatePicker } from "./calendar-date-picker";
import { agentColor } from "./calendar-colors";
import {
  getWeekLabel,
  getLocalFractionalHour,
  computeEventLayout,
  type LayoutEvent,
} from "./calendar-week-utils";
import { dateKey, sameDay } from "./calendar-month-grid";

const HOUR_HEIGHT = 48;
const EVENT_HEIGHT = 24;
const HOURS = Array.from({ length: 24 }, (_, i) => i);

function formatHourLabel(hour: number, compact: boolean): string {
  if (compact) {
    if (hour === 0) return "12a";
    if (hour < 12) return `${hour}a`;
    if (hour === 12) return "12p";
    return `${hour - 12}p`;
  }
  return `${String(hour).padStart(2, "0")}:00`;
}

function formatDayHeader(date: Date, compact: boolean): string {
  if (compact) {
    return ["S", "M", "T", "W", "T", "F", "S"][date.getDay()]!;
  }
  const weekday = date.toLocaleDateString("en-US", { weekday: "short" });
  return `${weekday} ${date.getDate()}`;
}

export interface CalendarWeekGridProps {
  weekStart: Date;
  events: CalendarEvent[];
  agents: Agent[];
  loading: boolean;
  focusedDate: Date;
  onPrevWeek: () => void;
  onNextWeek: () => void;
  onJumpToToday: () => void;
  onJumpToDate: (date: Date) => void;
  onSelectSlot: (date: Date, hour: number) => void;
  onSelectEvent: (event: CalendarEvent) => void;
  headerExtras?: React.ReactNode;
}

export function CalendarWeekGrid({
  weekStart,
  events,
  agents,
  loading,
  focusedDate,
  onPrevWeek,
  onNextWeek,
  onJumpToToday,
  onJumpToDate,
  onSelectSlot,
  onSelectEvent,
  headerExtras,
}: CalendarWeekGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const didAutoScroll = useRef(false);

  const today = new Date();
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 6);

  const weekLabel = getWeekLabel(weekStart, weekEnd);
  const isCurrentWeek =
    today >= weekStart &&
    today <=
      new Date(
        weekEnd.getFullYear(),
        weekEnd.getMonth(),
        weekEnd.getDate(),
        23,
        59,
        59,
        999
      );

  const days = useMemo(() => {
    const arr: Date[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStart);
      d.setDate(weekStart.getDate() + i);
      arr.push(d);
    }
    return arr;
  }, [weekStart]);

  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const ev of events) {
      const key = dateKey(new Date(ev.scheduled_at));
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(ev);
    }
    return map;
  }, [events]);

  const layoutByDay = useMemo(() => {
    const map = new Map<string, LayoutEvent[]>();
    for (const [key, dayEvents] of eventsByDay) {
      map.set(key, computeEventLayout(dayEvents));
    }
    return map;
  }, [eventsByDay]);

  const agentNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of agents) map.set(a.id, a.name);
    return map;
  }, [agents]);

  useEffect(() => {
    if (didAutoScroll.current) return;
    if (!scrollRef.current) return;
    const now = new Date();
    const scrollTo = Math.max(0, (now.getHours() - 1) * HOUR_HEIGHT);
    scrollRef.current.scrollTop = scrollTo;
    didAutoScroll.current = true;
  }, []);

  const currentFractionalHour = useMemo(() => {
    const now = new Date();
    return now.getHours() + now.getMinutes() / 60;
  }, []);

  if (loading && events.length === 0) {
    return (
      <div className="flex flex-1 flex-col gap-3 min-h-0">
        <div className="flex items-center justify-between flex-wrap gap-2 shrink-0">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-7 w-32" />
        </div>
        <div className="flex-1 min-h-0 flex flex-col rounded-lg border border-border/50 overflow-hidden">
          <div className="grid grid-cols-[3.5rem_repeat(7,1fr)] border-b border-border/30 shrink-0">
            <div className="h-8" />
            {Array.from({ length: 7 }).map((_, i) => (
              <Skeleton key={i} className="h-5 mx-2 my-1.5" />
            ))}
          </div>
          <div className="flex-1 min-h-0 overflow-hidden">
            {Array.from({ length: 12 }).map((_, i) => (
              <div
                key={i}
                className="grid grid-cols-[3.5rem_repeat(7,1fr)] border-b border-border/10"
                style={{ height: HOUR_HEIGHT }}
              >
                <Skeleton className="h-3 w-8 mx-1 my-2" />
                {Array.from({ length: 7 }).map((_, j) => (
                  <div key={j} className="relative">
                    {i % 4 === j % 3 && (
                      <Skeleton
                        className="absolute left-1 right-1 top-2 rounded-sm"
                        style={{ height: EVENT_HEIGHT }}
                      />
                    )}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-3 min-h-0">
      <div className="flex items-center justify-between flex-wrap gap-2 shrink-0">
        <h2 className="text-sm font-medium tabular-nums">{weekLabel}</h2>
        <div className="flex items-center gap-2">
          {headerExtras}
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label="Previous week"
              onClick={onPrevWeek}
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
            >
              <ChevronLeft className="size-4" />
            </button>
            <Button
              variant="outline"
              size="sm"
              onClick={onJumpToToday}
              disabled={isCurrentWeek}
              className="h-7 px-2.5 text-xs"
            >
              Today
            </Button>
            <button
              type="button"
              aria-label="Next week"
              onClick={onNextWeek}
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
            >
              <ChevronRight className="size-4" />
            </button>
          </div>
          <CalendarDatePicker
            value={focusedDate}
            onChange={onJumpToDate}
            ariaLabel="Jump to date"
          />
        </div>
      </div>

      <div className="relative flex-1 min-h-0 flex flex-col rounded-lg border border-border/50 overflow-hidden">
        {loading && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 z-20 h-0.5 overflow-hidden rounded-t-lg"
          >
            <div className="h-full w-1/3 animate-[calendar-progress_1.2s_ease-in-out_infinite] bg-foreground/40" />
          </div>
        )}

        <div
          role="grid"
          aria-label={`Week of ${weekLabel}`}
          aria-busy={loading || undefined}
          className={cn(
            "flex flex-1 flex-col min-h-0 transition-opacity",
            loading && "opacity-70"
          )}
        >
          {/* Sticky day headers */}
          <div
            role="row"
            className="sticky top-0 z-10 grid grid-cols-[3.5rem_repeat(7,1fr)] border-b border-border/30 bg-background"
          >
            <div role="columnheader" className="h-8" />
            {days.map((day) => {
              const isToday = sameDay(day, today);
              const compact = false; // TODO: responsive via media query hook if needed
              return (
                <div
                  key={dateKey(day)}
                  role="columnheader"
                  aria-current={isToday ? "date" : undefined}
                  className={cn(
                    "flex items-center justify-center h-8 text-xs font-medium",
                    isToday
                      ? "text-foreground"
                      : "text-muted-foreground"
                  )}
                >
                  <span
                    className={cn(
                      "px-1.5 py-0.5 rounded-md",
                      isToday && "bg-foreground text-background"
                    )}
                  >
                    {formatDayHeader(day, compact)}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Scrollable time grid */}
          <div
            ref={scrollRef}
            className="flex-1 min-h-0 overflow-y-auto thin-scrollbar"
          >
            <div className="relative grid grid-cols-[3.5rem_repeat(7,1fr)]">
              {/* Time gutter */}
              <div role="rowheader" className="relative">
                {HOURS.map((hour) => (
                  <div
                    key={hour}
                    className="flex items-start justify-end pr-2 text-[10px] text-muted-foreground tabular-nums"
                    style={{ height: HOUR_HEIGHT }}
                  >
                    <span className="-mt-1.5">
                      {hour === 0 ? "" : formatHourLabel(hour, false)}
                    </span>
                  </div>
                ))}
              </div>

              {/* Day columns */}
              {days.map((day) => {
                const key = dateKey(day);
                const isToday = sameDay(day, today);
                const layoutEvents = layoutByDay.get(key) ?? [];

                return (
                  <div
                    key={key}
                    className="relative border-l border-border/20"
                    style={{ height: HOUR_HEIGHT * 24 }}
                  >
                    {/* Hour slots */}
                    {HOURS.map((hour) => (
                      <div
                        key={hour}
                        className="absolute inset-x-0 border-t border-border/15 cursor-pointer hover:bg-accent/30 transition-colors"
                        style={{ top: hour * HOUR_HEIGHT, height: HOUR_HEIGHT }}
                        onClick={() => onSelectSlot(day, hour)}
                      />
                    ))}

                    {/* Current time indicator */}
                    {isToday && (
                      <div
                        className="absolute inset-x-0 z-10 pointer-events-none"
                        style={{ top: currentFractionalHour * HOUR_HEIGHT }}
                      >
                        <div className="h-px bg-foreground/40" />
                        <div className="absolute -left-0.5 -top-0.75 size-1.75 rounded-full bg-foreground/40" />
                      </div>
                    )}

                    {/* Events */}
                    {layoutEvents.map(({ event, columnIndex, columnCount }) => {
                      const fracHour = getLocalFractionalHour(
                        event.scheduled_at
                      );
                      const top = fracHour * HOUR_HEIGHT;
                      const widthPercent = 100 / columnCount;
                      const leftPercent = columnIndex * widthPercent;
                      const agentName = agentNameById.get(event.agent_id);
                      const timeStr = new Date(
                        event.scheduled_at
                      ).toLocaleTimeString(undefined, {
                        hour: "2-digit",
                        minute: "2-digit",
                        hour12: false,
                      });

                      return (
                        <button
                          key={`${event.id}@${event.occurrence_at}`}
                          type="button"
                          role="button"
                          aria-label={`${event.title} at ${timeStr}${agentName ? ` \u2014 ${agentName}` : ""}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            onSelectEvent(event);
                          }}
                          className={cn(
                            "absolute rounded-sm px-1.5 text-[10px] font-medium truncate text-left transition-colors hover:opacity-80 cursor-pointer",
                            agentColor(event.agent_id)
                          )}
                          style={{
                            top,
                            height: EVENT_HEIGHT,
                            left: `${leftPercent}%`,
                            width: `calc(${widthPercent}% - 2px)`,
                            marginLeft: 1,
                            lineHeight: `${EVENT_HEIGHT}px`,
                          }}
                          title={`${event.title}${agentName ? ` \u2014 ${agentName}` : ""}`}
                        >
                          {event.title}
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
