"use client"

import { useMemo, useRef } from "react"
import { CalendarDays, RefreshCw, TriangleAlertIcon } from "@/components/icons/lucide"
import { EmptyState } from "@/components/community/empty-state"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useInitialWeekScroll, useScheduleClockMinute } from "@/hooks/community/use-schedule"
import { tid } from "@/lib/community/testids"
import { cn } from "@/lib/utils"
import { ScheduleActorAvatar } from "./schedule-actor"
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
} from "./schedule-date"
import {
  ScheduleRecurrenceBadge,
  ScheduleRunStatusBadge,
  ScheduleSourceRefPill,
  ScheduleSourceStatusBadge,
  ScheduleStatusDot,
} from "./schedule-status"
import type { ScheduleOccurrenceItem } from "./schedule-types"
import styles from "./schedule.module.css"

const TOTAL_GRID_HEIGHT_PX = WEEK_HOURS.length * WEEK_HOUR_HEIGHT_PX

export function ScheduleWeekView({
  weekDays,
  selectedDay,
  onSelectDay,
  occurrences,
  selectedOccurrenceKey,
  onSelectOccurrence,
  onOpenSourceMessage,
}: {
  weekDays: readonly Date[]
  selectedDay: Date
  onSelectDay: (day: Date) => void
  occurrences: readonly ScheduleOccurrenceItem[]
  selectedOccurrenceKey: string | null
  onSelectOccurrence: (occurrence: ScheduleOccurrenceItem) => void
  onOpenSourceMessage: (messageId: string) => void
}) {
  const now = useScheduleClockMinute()
  const scrollViewportRef = useRef<HTMLDivElement>(null)
  const initialHour = Math.max(0, Math.min(18, now.getHours() - 1, 8))
  useInitialWeekScroll(scrollViewportRef, WEEK_HOUR_HEIGHT_PX, initialHour)

  const byDayKey = useMemo(() => {
    const map = new Map<string, ScheduleOccurrenceItem[]>()
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
    <div data-testid={tid.scheduleWeekGrid} className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col sm:hidden">
        <div className="flex shrink-0 flex-col gap-3 border-b border-border/50 bg-background px-4 pt-3 pb-3">
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
                  <span className="text-[11px] font-medium opacity-80">
                    {formatWeekdayShort(day)}
                  </span>
                  <span className="font-mono text-sm leading-none font-semibold tabular-nums">
                    {day.getDate()}
                  </span>
                  <span aria-hidden className="flex h-1.5 items-center gap-0.5">
                    {dayItems.slice(0, 3).map((item) => {
                      const runStatus = item.runStatus ?? item.event.lastExecution?.status ?? null
                      const degraded = !item.event.sourceMessage.accessible || runStatus === "blocked_access"
                      return (
                        <ScheduleStatusDot
                          key={item.occurrenceKey}
                          status={runStatus}
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
                ? "No tasks"
                : mobileDayItems.length === 1
                  ? "1 task"
                  : `${mobileDayItems.length} tasks`}
            </span>
          </div>
        </div>

        <ScrollArea className="min-h-0 flex-1" contentClassName="flex min-h-full flex-col">
          {mobileDayItems.length === 0 ? (
            <div className="flex flex-1 items-center justify-center px-6 py-16">
              <EmptyState icon={CalendarDays} label="No scheduled tasks for this day." />
            </div>
          ) : (
            <div className="flex flex-col divide-y divide-border/45 pb-6">
              {mobileDayItems.map((occurrence) => {
                const { event } = occurrence
                const runStatus = occurrence.runStatus ?? event.lastExecution?.status ?? null
                const degraded = !event.sourceMessage.accessible || runStatus === "blocked_access"
                return (
                  <div
                    key={occurrence.occurrenceKey}
                    role="button"
                    tabIndex={0}
                    data-testid={tid.scheduleEvent(event.id)}
                    onClick={() => onSelectOccurrence(occurrence)}
                    onKeyDown={(keyEvent) => {
                      if (keyEvent.target === keyEvent.currentTarget && (keyEvent.key === "Enter" || keyEvent.key === " ")) {
                        keyEvent.preventDefault()
                        onSelectOccurrence(occurrence)
                      }
                    }}
                    className={cn(
                      styles.ledgerRow,
                      "flex min-h-11 w-full cursor-pointer flex-col gap-2 px-4 py-3.5 text-left hover:bg-muted/45 active:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset",
                      degraded && "bg-warning/6 hover:bg-warning/10",
                      selectedOccurrenceKey === occurrence.occurrenceKey && "bg-muted/60",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-2 font-mono text-xs font-medium tabular-nums text-muted-foreground">
                        <ScheduleStatusDot status={runStatus} degraded={degraded} />
                        <span>{formatTimeRange(occurrence.startAt, occurrence.endAt)}</span>
                      </span>
                      <div className="flex flex-wrap items-center justify-end gap-1.5">
                        <ScheduleRecurrenceBadge recurrence={event.recurrence} compact />
                        <ScheduleSourceStatusBadge source={event.sourceMessage} runStatus={runStatus} compact />
                        <ScheduleRunStatusBadge status={runStatus} />
                      </div>
                    </div>
                    <div className="flex min-w-0 flex-col gap-1">
                      <div className="text-sm leading-snug font-medium text-foreground">{event.title}</div>
                      {event.description ? (
                        <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                          {event.description}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                      <span className="flex min-w-0 items-center gap-2">
                        <ScheduleActorAvatar actor={event.creator} size={18} />
                        <span className="truncate font-medium text-foreground/85">{event.creator.name}</span>
                      </span>
                      <ScheduleSourceRefPill
                        source={event.sourceMessage}
                        onOpenSourceMessage={onOpenSourceMessage}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </ScrollArea>
      </div>

      <div className="hidden min-h-0 flex-1 flex-col bg-background sm:flex">
        <div className="grid shrink-0 grid-cols-[4rem_repeat(7,minmax(0,1fr))] border-b border-border/65 bg-background">
          <div className="flex items-end justify-end border-r border-border/45 pr-2.5 pb-2 select-none">
            <span
              title={tzFull}
              className="font-mono text-[10px] leading-none font-medium tracking-wide text-muted-foreground/80"
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
                  "flex flex-col items-center justify-center gap-1 border-r border-border/35 px-1.5 py-2.5 text-center transition-colors duration-150 last:border-r-0 hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset motion-reduce:transition-none",
                  isToday && "bg-primary/4 dark:bg-primary/7",
                )}
              >
                <span
                  className={cn(
                    "text-xs font-medium",
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
                        ? "bg-muted text-foreground"
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
                      <ScheduleStatusDot
                        key={item.occurrenceKey}
                        status={runStatus}
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
          viewportClassName="size-full"
        >
          <div
            className="relative grid grid-cols-[4rem_repeat(7,minmax(0,1fr))]"
            style={{ height: TOTAL_GRID_HEIGHT_PX }}
          >
            <div className="relative border-r border-border/45 bg-background select-none">
              {WEEK_HOURS.map((hour) => (
                <div
                  key={hour}
                  className="relative pr-2.5 text-right font-mono text-[10px] tabular-nums text-muted-foreground/75"
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
                    "relative border-r border-border/35 last:border-r-0",
                    isToday && "bg-primary/3 dark:bg-primary/6",
                  )}
                >
                  {WEEK_HOURS.map((hour) => (
                    <div
                      key={hour}
                      className={cn(styles.hourCell, "border-b border-border/40 last:border-b-0")}
                      style={{ height: WEEK_HOUR_HEIGHT_PX }}
                    />
                  ))}

                  {isToday ? (
                    <>
                      <div
                        aria-hidden
                        className="pointer-events-none absolute inset-x-0 z-10 h-0.5 bg-primary/80"
                        style={{ top: nowTopPx }}
                      />
                      <span
                        aria-hidden
                        className="pointer-events-none absolute -left-1 z-30 size-2 -translate-y-1/2 rounded-full bg-primary ring-2 ring-background"
                        style={{ top: nowTopPx }}
                      />
                    </>
                  ) : null}

                  {blocks.map((block) => {
                    const { item } = block
                    const { event } = item
                    const runStatus = item.runStatus ?? event.lastExecution?.status ?? null
                    const degraded = !event.sourceMessage.accessible || runStatus === "blocked_access"
                    const pendingAttention = degraded || runStatus === "pending"
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
                        data-testid={tid.scheduleEvent(event.id)}
                        onClick={() => onSelectOccurrence(item)}
                        style={{
                          top: block.topPx + 1,
                          height: Math.max(28, block.heightPx - 2),
                          left: `calc(${leftPct}% + 3px)`,
                          width: `calc(${widthPct}% - 6px)`,
                        }}
                        className={cn(
                          "group absolute z-20 flex overflow-hidden rounded-lg border text-left transition-colors duration-150 hover:z-30 focus-visible:z-30 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none motion-reduce:transition-none",
                          singleLine ? "flex-row items-center gap-1.5 px-2 py-0.5" : "flex-col gap-0.5 px-2.5 py-1.5",
                          pendingAttention
                            ? "border-warning/35 bg-warning/13 hover:bg-warning/20"
                            : settled
                              ? "border-border/80 bg-muted/75 hover:bg-muted dark:border-white/12 dark:bg-white/6 dark:hover:bg-white/10"
                              : "border-primary/28 bg-primary/11 hover:bg-primary/17 dark:border-primary/35 dark:bg-primary/18 dark:hover:bg-primary/26",
                          selectedOccurrenceKey === item.occurrenceKey && "ring-2 ring-ring ring-offset-1 ring-offset-background",
                        )}
                      >
                        {singleLine ? (
                          <>
                            <ScheduleStatusDot
                              status={runStatus}
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
                              <ScheduleStatusDot
                                status={runStatus}
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
                                <ScheduleActorAvatar actor={event.creator} size={14} />
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
