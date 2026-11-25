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
  formatLocalTimeZoneFull,
  formatLocalTimeZoneShort,
  formatMobileDayHeading,
  formatTimeRange,
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
  CalendarStatusDot,
} from "./calendar-status"
import type { CalendarOccurrenceItem } from "./calendar-types"
import styles from "./calendar.module.css"

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
  const tzShort = useMemo(() => formatLocalTimeZoneShort(now), [now])
  const tzFull = useMemo(() => formatLocalTimeZoneFull(), [])
  const mobileDayHeading = useMemo(() => formatMobileDayHeading(selectedDay, now), [selectedDay, now])

  return (
    <div data-testid={tid.calendarWeekGrid} className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex flex-col gap-4 sm:hidden">
        <div
          role="tablist"
          aria-label="Days of week"
          className={styles.dayStrip}
        >
          {weekDays.map((day) => {
            const key = localDayKey(day)
            const isSelected = key === selectedDayKey
            const isToday = isSameLocalDay(day, now)
            const dayItems = byDayKey.get(key) ?? []
            return (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={isSelected}
                data-selected={isSelected || undefined}
                data-today={isToday || undefined}
                onClick={() => onSelectDay(day)}
                className={cn(
                  styles.dayKey,
                  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                  !isSelected && isToday && "text-primary",
                )}
              >
                <span className="text-[10px] font-semibold tracking-wider uppercase opacity-80">
                  {formatWeekdayShort(day)}
                </span>
                <span className="font-mono text-sm font-semibold tabular-nums leading-none">
                  {day.getDate()}
                </span>
                <span aria-hidden className="flex h-1.5 items-center gap-0.5">
                  {dayItems.slice(0, 3).map((item) => {
                    const runStatus = item.runStatus ?? item.event.lastExecution?.status ?? null
                    const degraded = !item.event.sourceMessage.accessible || runStatus === "blocked_access"
                    return (
                      <CalendarStatusDot
                        key={item.occurrenceKey}
                        status={runStatus}
                        paused={item.event.paused}
                        degraded={degraded}
                        size="sm"
                        className={cn(
                          "size-1",
                          isSelected && isToday && "bg-primary-foreground/90",
                        )}
                      />
                    )
                  })}
                </span>
              </button>
            )
          })}
        </div>

        <div className="flex items-center justify-between gap-2 px-0.5">
          <h2 className="text-xs font-semibold text-foreground">{mobileDayHeading}</h2>
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {mobileDayItems.length === 0
              ? "No events"
              : mobileDayItems.length === 1
                ? "1 event"
                : `${mobileDayItems.length} events`}
          </span>
        </div>

        <div className="flex flex-col gap-2.5">
          {mobileDayItems.length === 0 ? (
            <div className="rounded-2xl border border-border/70 bg-card/60 py-12">
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
                    styles.eventCard,
                    "flex min-h-11 w-full flex-col gap-2.5 rounded-2xl p-3.5 text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                    degraded && "border-warning/35 bg-warning/6 hover:bg-warning/10",
                    event.paused && "border-dashed opacity-80",
                    selectedOccurrenceKey === occurrence.occurrenceKey && "ring-2 ring-ring",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2 font-mono text-xs font-medium tabular-nums text-muted-foreground">
                      <CalendarStatusDot status={runStatus} paused={event.paused} degraded={degraded} />
                      <span>{formatTimeRange(occurrence.startAt, occurrence.endAt)}</span>
                    </span>
                    <div className="flex flex-wrap items-center justify-end gap-1.5">
                      <CalendarRecurrenceBadge recurrence={event.recurrence} compact />
                      <CalendarSourceStatusBadge source={event.sourceMessage} runStatus={runStatus} compact />
                      <CalendarRunStatusBadge status={runStatus} paused={event.paused} />
                    </div>
                  </div>
                  <div className="flex min-w-0 flex-col gap-1">
                    <div className="text-sm font-medium leading-snug text-foreground">{event.title}</div>
                    {event.description ? (
                      <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                        {event.description}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <CalendarActorAvatar actor={event.creator} size={18} />
                    <span className="truncate font-medium text-foreground/85">{event.creator.name}</span>
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

      <div className={cn(styles.gridShell, "hidden min-h-0 flex-1 flex-col overflow-hidden sm:flex")}>
        <div className={cn(styles.gridHeader, "grid shrink-0 grid-cols-[3.75rem_repeat(7,minmax(0,1fr))] border-b border-border/75")}>
          <div className="flex items-end justify-center border-r border-border/50 px-1 pb-2.5 select-none">
            <span
              title={tzFull}
              className="rounded-md bg-muted/90 px-1.5 py-0.5 font-mono text-[10px] leading-none font-medium text-muted-foreground"
            >
              {tzShort}
            </span>
          </div>
          {weekDays.map((day) => {
            const key = localDayKey(day)
            const isToday = isSameLocalDay(day, now)
            const isSelected = key === selectedDayKey
            const dayItems = byDayKey.get(key) ?? []
            return (
              <button
                key={key}
                type="button"
                onClick={() => onSelectDay(day)}
                className={cn(
                  "flex flex-col items-center justify-center gap-1 border-r border-border/45 px-1.5 py-3 text-center transition-colors duration-150 last:border-r-0 hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset motion-reduce:transition-none",
                  isToday && "bg-primary/6 dark:bg-primary/10",
                )}
              >
                <span
                  className={cn(
                    "text-[10px] font-semibold tracking-widest uppercase",
                    isToday ? "text-primary" : "text-muted-foreground",
                  )}
                >
                  {formatWeekdayShort(day)}
                </span>
                <span
                  className={cn(
                    "grid size-8 place-items-center rounded-full font-mono text-[15px] font-semibold tabular-nums transition-colors",
                    isToday
                      ? styles.todayDisc
                      : isSelected
                        ? "bg-card text-foreground ring-1 ring-border"
                        : "text-foreground",
                  )}
                >
                  {day.getDate()}
                </span>
                <span aria-hidden className="flex h-1.5 items-center gap-1">
                  {dayItems.slice(0, 3).map((item) => {
                    const runStatus = item.runStatus ?? item.event.lastExecution?.status ?? null
                    const degraded = !item.event.sourceMessage.accessible || runStatus === "blocked_access"
                    return (
                      <CalendarStatusDot
                        key={item.occurrenceKey}
                        status={runStatus}
                        paused={item.event.paused}
                        degraded={degraded}
                        size="sm"
                        className="size-1.25"
                      />
                    )
                  })}
                </span>
              </button>
            )
          })}
        </div>

        <ScrollArea
          viewportRef={scrollViewportRef}
          className="min-h-0 flex-1"
          viewportClassName="h-[calc(100dvh-11.5rem)] min-h-108 max-h-200"
        >
          <div
            className="relative grid grid-cols-[3.75rem_repeat(7,minmax(0,1fr))]"
            style={{ height: TOTAL_GRID_HEIGHT_PX }}
          >
            <div className="relative border-r border-border/50 bg-card select-none">
              {WEEK_HOURS.map((hour) => (
                <div
                  key={hour}
                  className="relative pr-2.5 text-right font-mono text-[10px] tabular-nums text-muted-foreground/80"
                  style={{ height: WEEK_HOUR_HEIGHT_PX }}
                >
                  {hour > 0 ? (
                    <span className="relative -top-1.5 inline-block leading-none">{formatHourLabel(hour)}</span>
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
                    isToday && "bg-primary/4 dark:bg-primary/7",
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
                    <>
                      <div
                        aria-hidden
                        className="pointer-events-none absolute inset-x-0 z-10 h-px bg-primary/80"
                        style={{ top: nowTopPx }}
                      />
                      <span
                        aria-hidden
                        className="pointer-events-none absolute -left-1.25 z-30 size-2.5 -translate-y-1/2 rounded-full bg-primary ring-2 ring-card"
                        style={{ top: nowTopPx }}
                      />
                    </>
                  ) : null}

                  {blocks.map((block) => {
                    const { item } = block
                    const { event } = item
                    const runStatus = item.runStatus ?? event.lastExecution?.status ?? null
                    const degraded = !event.sourceMessage.accessible || runStatus === "blocked_access"
                    const settled = runStatus === "completed"
                    const widthPct = 100 / block.columnCount
                    const leftPct = block.column * widthPct
                    const singleLine = block.heightPx < 44
                    const showCreator = block.heightPx >= 72

                    return (
                      <button
                        key={item.occurrenceKey}
                        type="button"
                        title={`${event.title} (${formatTimeRange(item.startAt, item.endAt)})`}
                        data-testid={tid.calendarEvent(event.id)}
                        onClick={() => onSelectOccurrence(item)}
                        style={{
                          top: block.topPx + 1,
                          height: Math.max(28, block.heightPx - 2),
                          left: `calc(${leftPct}% + 2px)`,
                          width: `calc(${widthPct}% - 4px)`,
                        }}
                        className={cn(
                          "group absolute z-20 flex overflow-hidden rounded-md border text-left transition-colors duration-150 hover:z-30 focus-visible:z-30 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none motion-reduce:transition-none",
                          singleLine ? "flex-row items-center gap-1.5 px-2 py-0.5" : "flex-col gap-0.5 px-2 py-1.5",
                          degraded
                            ? "border-warning/40 bg-warning/14 hover:bg-warning/20"
                            : event.paused
                              ? "border-dashed border-border bg-muted/60 opacity-80 hover:opacity-100"
                              : settled
                                ? "border-border/80 bg-muted/75 hover:bg-muted"
                                : "border-primary/25 bg-primary/12 hover:bg-primary/18 dark:border-primary/35 dark:bg-primary/18 dark:hover:bg-primary/25",
                          selectedOccurrenceKey === item.occurrenceKey && "ring-2 ring-ring ring-offset-1 ring-offset-card",
                        )}
                      >
                        {singleLine ? (
                          <>
                            <CalendarStatusDot
                              status={runStatus}
                              paused={event.paused}
                              degraded={degraded}
                              size="sm"
                            />
                            <span className="min-w-0 flex-1 truncate text-xs leading-none font-medium text-foreground">
                              {event.title}
                            </span>
                            {degraded ? (
                              <TriangleAlertIcon className="size-3 shrink-0 text-warning" aria-label="Attention needed" />
                            ) : null}
                          </>
                        ) : (
                          <>
                            <div className="flex items-center gap-1.5">
                              <CalendarStatusDot
                                status={runStatus}
                                paused={event.paused}
                                degraded={degraded}
                                size="sm"
                              />
                              <span className="min-w-0 flex-1 truncate text-xs leading-tight font-medium text-foreground">
                                {event.title}
                              </span>
                              {degraded ? (
                                <TriangleAlertIcon className="size-3 shrink-0 text-warning" aria-label="Attention needed" />
                              ) : event.recurrence.recurring ? (
                                <RefreshCw className="size-2.5 shrink-0 text-muted-foreground" aria-hidden />
                              ) : null}
                            </div>
                            <div className="pl-3 font-mono text-[10px] leading-tight tabular-nums text-muted-foreground">
                              {formatTimeRange(item.startAt, item.endAt)}
                            </div>
                            {showCreator ? (
                              <div className="mt-auto flex items-center gap-1.5 pt-1 text-[11px] text-muted-foreground">
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
