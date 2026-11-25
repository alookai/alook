"use client"

import { useMemo, useRef } from "react"
import { CalendarDays, RefreshCw, TriangleAlertIcon } from "@/components/icons/lucide"
import { EmptyState } from "@/components/community/empty-state"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useCalendarClockMinute, useInitialWeekScroll } from "@/hooks/community/use-calendar"
import { tid } from "@/lib/community/testids"
import { cn } from "@/lib/utils"
import { CalendarActorAvatar } from "./calendar-actor"
import {
  formatHourLabel,
  formatTimeRange,
  formatTimeShort,
  formatWeekdayShort,
  isSameLocalDay,
  layoutDayOccurrences,
  localDayKey,
  WEEK_HOUR_HEIGHT_PX,
  WEEK_HOURS,
} from "./calendar-date"
import {
  CalendarRecurrenceBadge,
  CalendarRunStatusBadge,
  CalendarSourceStatusBadge,
} from "./calendar-status"
import type { CalendarOccurrenceItem } from "./calendar-types"

const TOTAL_GRID_HEIGHT_PX = WEEK_HOURS.length * WEEK_HOUR_HEIGHT_PX

export function CalendarWeekView({
  weekDays,
  selectedDay,
  onSelectDay,
  occurrences,
  selectedOccurrenceKey,
  onSelectOccurrence,
}: {
  weekDays: readonly Date[]
  selectedDay: Date
  onSelectDay: (day: Date) => void
  occurrences: readonly CalendarOccurrenceItem[]
  selectedOccurrenceKey: string | null
  onSelectOccurrence: (occurrence: CalendarOccurrenceItem) => void
}) {
  const now = useCalendarClockMinute()
  const scrollViewportRef = useRef<HTMLDivElement>(null)
  const initialHour = Math.max(0, Math.min(18, now.getHours() - 1, 8))
  useInitialWeekScroll(scrollViewportRef, WEEK_HOUR_HEIGHT_PX, initialHour)

  const byDayKey = useMemo(() => {
    const map = new Map<string, CalendarOccurrenceItem[]>()
    for (const day of weekDays) map.set(localDayKey(day), [])
    for (const item of occurrences) {
      const d = new Date(item.startAt)
      if (Number.isNaN(d.getTime())) continue
      const key = localDayKey(d)
      const bucket = map.get(key)
      if (bucket) bucket.push(item)
    }
    for (const list of map.values()) {
      list.sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime())
    }
    return map
  }, [occurrences, weekDays])

  const selectedDayKey = localDayKey(selectedDay)
  const mobileDayItems = byDayKey.get(selectedDayKey) ?? []
  const nowMinutes = now.getHours() * 60 + now.getMinutes()
  const nowTopPx = (nowMinutes / 60) * WEEK_HOUR_HEIGHT_PX

  return (
    <div data-testid={tid.calendarWeekGrid} className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex flex-col gap-4 sm:hidden">
        <div
          role="tablist"
          aria-label="Days of week"
          className="grid grid-cols-7 gap-1 rounded-lg border border-border/70 bg-card p-1.5"
        >
          {weekDays.map((day) => {
            const key = localDayKey(day)
            const isSelected = key === selectedDayKey
            const isToday = isSameLocalDay(day, now)
            const count = byDayKey.get(key)?.length ?? 0
            return (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={isSelected}
                onClick={() => onSelectDay(day)}
                className={cn(
                  "flex min-h-14 flex-col items-center justify-center gap-1 rounded-md px-1 py-1.5 transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none motion-reduce:transition-none",
                  isSelected
                    ? "bg-primary text-primary-foreground"
                    : isToday
                      ? "bg-secondary text-foreground ring-1 ring-border/80 ring-inset"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                <span className="text-[11px] font-medium uppercase">{formatWeekdayShort(day)}</span>
                <span className="font-mono text-sm font-semibold tabular-nums">{day.getDate()}</span>
                <span
                  aria-hidden
                  className={cn(
                    "size-1.5 rounded-full",
                    count > 0
                      ? isSelected
                        ? "bg-primary-foreground"
                        : "bg-primary"
                      : "bg-transparent",
                  )}
                />
              </button>
            )
          })}
        </div>

        <div className="flex flex-col gap-3">
          {mobileDayItems.length === 0 ? (
            <div className="rounded-lg border border-border/60 bg-card/50 py-10">
              <EmptyState icon={CalendarDays} label="No events scheduled for this day." />
            </div>
          ) : (
            mobileDayItems.map((occurrence) => {
              const { event } = occurrence
              const runStatus = occurrence.runStatus ?? event.lastExecution?.status ?? null
              const degraded = !event.sourceMessage.accessible || runStatus === "blocked_access"
              return (
                <button
                  key={occurrence.occurrenceKey}
                  type="button"
                  data-testid={tid.calendarEvent(event.id)}
                  onClick={() => onSelectOccurrence(occurrence)}
                  className={cn(
                    "flex min-h-11 w-full flex-col gap-2 rounded-lg border border-border/70 border-l-2 bg-card p-4 text-left transition-colors duration-150 hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none motion-reduce:transition-none",
                    degraded
                      ? "border-l-warning"
                      : event.paused
                        ? "border-l-muted-foreground/50 opacity-80"
                        : "border-l-primary",
                    selectedOccurrenceKey === occurrence.occurrenceKey && "ring-1 ring-ring",
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="font-mono text-xs tabular-nums text-muted-foreground">
                      {formatTimeRange(occurrence.startAt, occurrence.endAt)}
                    </span>
                    <div className="flex flex-wrap items-center justify-end gap-1.5">
                      <CalendarRecurrenceBadge recurrence={event.recurrence} compact />
                      <CalendarSourceStatusBadge source={event.sourceMessage} compact />
                      <CalendarRunStatusBadge status={runStatus} paused={event.paused} />
                    </div>
                  </div>
                  <div className="text-sm font-medium text-foreground">{event.title}</div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <CalendarActorAvatar actor={event.creator} size={18} />
                    <span className="truncate">{event.creator.name}</span>
                    {event.sourceMessage.accessible && event.sourceMessage.channelLabel ? (
                      <span className="truncate text-muted-foreground/80">
                        · {event.sourceMessage.channelLabel}
                      </span>
                    ) : null}
                  </div>
                </button>
              )
            })
          )}
        </div>
      </div>

      <div className="hidden min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border/70 bg-card sm:flex">
        <div className="grid shrink-0 grid-cols-[3.75rem_repeat(7,minmax(0,1fr))] border-b border-border/70 bg-secondary/40">
          <div className="flex items-center justify-center border-r border-border/50 px-1 py-3 font-mono text-[11px] text-muted-foreground">
            {Intl.DateTimeFormat().resolvedOptions().timeZone.split("/").pop()?.replaceAll("_", " ") ?? "Local"}
          </div>
          {weekDays.map((day) => {
            const key = localDayKey(day)
            const isToday = isSameLocalDay(day, now)
            const isSelected = key === selectedDayKey
            const count = byDayKey.get(key)?.length ?? 0
            return (
              <button
                key={key}
                type="button"
                onClick={() => onSelectDay(day)}
                className={cn(
                  "flex flex-col items-center justify-center gap-1 border-r border-border/40 px-2 py-2.5 text-center transition-colors duration-150 last:border-r-0 hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset motion-reduce:transition-none",
                  isToday && "bg-secondary/70",
                )}
              >
                <span className="text-xs font-medium text-muted-foreground">
                  {formatWeekdayShort(day)}
                </span>
                <span
                  className={cn(
                    "grid size-7 place-items-center rounded-full font-mono text-sm font-medium tabular-nums",
                    isToday
                      ? "bg-primary text-primary-foreground"
                      : isSelected
                        ? "bg-accent text-foreground ring-1 ring-border"
                        : "text-foreground",
                  )}
                >
                  {day.getDate()}
                </span>
                <span className="h-1.5 text-[10px] leading-none text-muted-foreground">
                  {count > 0 ? `${count}` : ""}
                </span>
              </button>
            )
          })}
        </div>

        <ScrollArea
          viewportRef={scrollViewportRef}
          className="min-h-0 flex-1"
          viewportClassName="h-[calc(100vh-17rem)] min-h-96"
        >
          <div
            className="relative grid grid-cols-[3.75rem_repeat(7,minmax(0,1fr))]"
            style={{ height: TOTAL_GRID_HEIGHT_PX }}
          >
            <div className="relative border-r border-border/50 bg-background/40 select-none">
              {WEEK_HOURS.map((hour) => (
                <div
                  key={hour}
                  className="relative pr-2 text-right font-mono text-[11px] tabular-nums text-muted-foreground"
                  style={{ height: WEEK_HOUR_HEIGHT_PX }}
                >
                  {hour > 0 ? (
                    <span className="relative -top-2 inline-block">{formatHourLabel(hour)}</span>
                  ) : null}
                </div>
              ))}
            </div>

            {weekDays.map((day) => {
              const key = localDayKey(day)
              const isToday = isSameLocalDay(day, now)
              const blocks = layoutDayOccurrences(byDayKey.get(key) ?? [], day, WEEK_HOUR_HEIGHT_PX)

              return (
                <div
                  key={key}
                  className={cn(
                    "relative border-r border-border/40 last:border-r-0",
                    isToday && "bg-secondary/25",
                  )}
                >
                  {WEEK_HOURS.map((hour) => (
                    <div
                      key={hour}
                      className="border-b border-border/40 last:border-b-0"
                      style={{ height: WEEK_HOUR_HEIGHT_PX }}
                    />
                  ))}

                  {isToday ? (
                    <div
                      aria-hidden
                      className="pointer-events-none absolute inset-x-0 z-20 flex items-center"
                      style={{ top: nowTopPx }}
                    >
                      <span className="-ml-1 size-2 shrink-0 rounded-full bg-primary" />
                      <span className="h-0.5 flex-1 bg-primary" />
                    </div>
                  ) : null}

                  {blocks.map((block) => {
                    const { item } = block
                    const { event } = item
                    const runStatus = item.runStatus ?? event.lastExecution?.status ?? null
                    const degraded = !event.sourceMessage.accessible || runStatus === "blocked_access"
                    const widthPct = 100 / block.columnCount
                    const leftPct = block.column * widthPct
                    const singleLine = block.heightPx < 44
                    const showCreator = block.heightPx >= 64

                    return (
                      <button
                        key={item.occurrenceKey}
                        type="button"
                        data-testid={tid.calendarEvent(event.id)}
                        onClick={() => onSelectOccurrence(item)}
                        style={{
                          top: block.topPx + 1,
                          height: Math.max(26, block.heightPx - 2),
                          left: `calc(${leftPct}% + 2px)`,
                          width: `calc(${widthPct}% - 4px)`,
                        }}
                        className={cn(
                          "group absolute z-10 flex overflow-hidden rounded-md border border-border/80 border-l-2 bg-background/95 text-left shadow-(--e1) transition-colors duration-150 hover:z-30 hover:bg-accent focus-visible:z-30 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none motion-reduce:transition-none",
                          singleLine ? "flex-row items-center gap-1 px-1.5 py-0.5" : "flex-col px-2 py-1",
                          degraded
                            ? "border-l-warning bg-warning/10 hover:bg-warning/15"
                            : event.paused
                              ? "border-l-muted-foreground/50 opacity-75"
                              : "border-l-primary",
                          selectedOccurrenceKey === item.occurrenceKey && "ring-2 ring-ring",
                        )}
                      >
                        {singleLine ? (
                          <>
                            <span className="shrink-0 font-mono text-[11px] leading-none tabular-nums text-muted-foreground">
                              {formatTimeShort(item.startAt)}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-xs leading-none font-medium text-foreground">
                              {event.title}
                            </span>
                            {event.recurrence.recurring ? (
                              <RefreshCw className="size-2.5 shrink-0 text-muted-foreground" aria-hidden />
                            ) : null}
                            {degraded ? (
                              <TriangleAlertIcon className="size-3 shrink-0 text-warning" aria-label="Attention needed" />
                            ) : null}
                          </>
                        ) : (
                          <>
                            <div className="flex items-center gap-1 text-[11px] leading-tight">
                              <span className="shrink-0 font-mono tabular-nums text-muted-foreground">
                                {formatTimeShort(item.startAt)}
                              </span>
                              {event.recurrence.recurring ? (
                                <RefreshCw className="size-2.5 shrink-0 text-muted-foreground" aria-hidden />
                              ) : null}
                              {degraded ? (
                                <TriangleAlertIcon className="ml-auto size-3 shrink-0 text-warning" aria-label="Attention needed" />
                              ) : null}
                            </div>
                            <div className="truncate text-xs leading-tight font-medium text-foreground">
                              {event.title}
                            </div>
                            {showCreator ? (
                              <div className="mt-auto flex items-center gap-1.5 pt-0.5 text-[11px] text-muted-foreground">
                                <CalendarActorAvatar actor={event.creator} size={14} />
                                <span className="truncate">{event.creator.name}</span>
                              </div>
                            ) : null}
                          </>
                        )}
                      </button>
                    )
                  })}
                </div>
              )
            })}
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
