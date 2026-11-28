"use client"

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
  type TransitionEvent,
} from "react"
import { CalendarDays, RefreshCw, TriangleAlertIcon } from "@/components/icons/lucide"
import { EmptyState } from "@/components/community/empty-state"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useInitialWeekScroll, useScheduleClockMinute } from "@/hooks/community/use-schedule"
import { tid } from "@/lib/community/testids"
import { cn } from "@/lib/utils"
import { ScheduleActorAvatar } from "./schedule-actor"
import {
  addLocalDays,
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
  advanceScheduleDaySwipe,
  beginScheduleDaySwipe,
  finishScheduleDaySwipe,
  type ScheduleDaySwipeGesture,
  type ScheduleDaySwipeStep,
} from "./schedule-mobile-swipe"
import { ScheduleAgendaInlineSkeleton, ScheduleWeekInlineSkeleton } from "./schedule-skeleton"
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
const SWIPE_SETTLE_FALLBACK_MS = 240

type MobileSwipeState =
  | { phase: "idle" }
  | { phase: "dragging"; offsetX: number; containerWidth: number }
  | { phase: "settling"; targetStep: ScheduleDaySwipeStep }

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  )
}

function hasActiveSelection(): boolean {
  if (typeof window === "undefined") return false
  const selection = window.getSelection?.()
  return Boolean(selection && !selection.isCollapsed && selection.rangeCount > 0)
}

function MobileDayPane({
  day,
  now,
  items,
  refreshing,
  selectedOccurrenceKey,
  onSelectOccurrence,
  interactive,
  slideClassName,
}: {
  day: Date
  now: Date
  items: readonly ScheduleOccurrenceItem[]
  refreshing: boolean
  selectedOccurrenceKey: string | null
  onSelectOccurrence: (occurrence: ScheduleOccurrenceItem) => void
  interactive: boolean
  slideClassName?: string
}) {
  const heading = useMemo(() => formatMobileDayHeading(day, now), [day, now])
  const countLabel = refreshing
    ? "Updating…"
    : items.length === 0
      ? "No tasks"
      : items.length === 1
        ? "1 task"
        : `${items.length} tasks`

  const body = refreshing ? (
    <ScheduleAgendaInlineSkeleton />
  ) : items.length === 0 ? (
    <div className="flex flex-1 items-center justify-center px-6 py-16">
      <EmptyState icon={CalendarDays} label="No scheduled tasks for this day." />
    </div>
  ) : (
    <div className="flex flex-col divide-y divide-border/45 pb-6">
      {items.map((occurrence) => {
        const { event } = occurrence
        const runStatus = occurrence.runStatus ?? event.lastExecution?.status ?? null
        const degraded = !event.sourceMessage.accessible || runStatus === "blocked_access"
        return (
          <div
            key={occurrence.occurrenceKey}
            role={interactive ? "button" : undefined}
            tabIndex={interactive ? 0 : undefined}
            data-testid={interactive ? tid.scheduleEvent(event.id) : undefined}
            onClick={interactive ? () => onSelectOccurrence(occurrence) : undefined}
            onKeyDown={interactive ? (keyEvent) => {
              if (keyEvent.target === keyEvent.currentTarget && (keyEvent.key === "Enter" || keyEvent.key === " ")) {
                keyEvent.preventDefault()
                onSelectOccurrence(occurrence)
              }
            } : undefined}
            className={cn(
              styles.ledgerRow,
              "flex min-h-11 w-full cursor-pointer flex-col gap-2 px-4 py-3.5 text-left hover:bg-muted/45 active:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset",
              degraded && "bg-warning/6 hover:bg-warning/10",
              interactive && selectedOccurrenceKey === occurrence.occurrenceKey && "bg-muted/60",
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
              <ScheduleSourceRefPill source={event.sourceMessage} />
            </div>
          </div>
        )
      })}
    </div>
  )

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col bg-background", slideClassName)}>
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/45 px-4 py-2.5">
        <h2 className="text-xs font-semibold text-foreground">{heading}</h2>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">{countLabel}</span>
      </div>
      {interactive ? (
        <ScrollArea className="min-h-0 flex-1" contentClassName="flex min-h-full flex-col">
          {body}
        </ScrollArea>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {body}
        </div>
      )}
    </div>
  )
}

export function ScheduleWeekView({
  weekKey,
  direction = 0,
  refreshing = false,
  weekDays,
  selectedDay,
  onSelectDay,
  occurrences,
  selectedOccurrenceKey,
  onSelectOccurrence,
}: {
  weekKey?: string
  direction?: -1 | 0 | 1
  refreshing?: boolean
  weekDays: readonly Date[]
  selectedDay: Date
  onSelectDay: (day: Date) => void
  occurrences: readonly ScheduleOccurrenceItem[]
  selectedOccurrenceKey: string | null
  onSelectOccurrence: (occurrence: ScheduleOccurrenceItem) => void
}) {
  const now = useScheduleClockMinute()
  const scrollViewportRef = useRef<HTMLDivElement>(null)
  const initialHour = Math.max(0, Math.min(18, now.getHours() - 1, 8))
  useInitialWeekScroll(scrollViewportRef, WEEK_HOUR_HEIGHT_PX, initialHour)

  const [swipeState, setSwipeState] = useState<MobileSwipeState>({ phase: "idle" })
  const [swipedToDayKey, setSwipedToDayKey] = useState<string | null>(null)
  const gestureRef = useRef<{ pointerId: number; gesture: ScheduleDaySwipeGesture } | null>(null)
  const suppressClickRef = useRef(false)
  const settleTimerRef = useRef<number | null>(null)
  const settledRef = useRef(false)

  const clearSettleTimer = useCallback(() => {
    if (settleTimerRef.current !== null) {
      window.clearTimeout(settleTimerRef.current)
      settleTimerRef.current = null
    }
  }, [])

  useEffect(() => clearSettleTimer, [clearSettleTimer])

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

  const resolvedWeekKey = weekKey ?? (weekDays[0] ? localDayKey(weekDays[0]) : localDayKey(selectedDay))
  const selectedDayKey = localDayKey(selectedDay)
  const selectedDayIndex = weekDays.findIndex((day) => localDayKey(day) === selectedDayKey)
  const isSelectedToday = selectedDayIndex >= 0 && isSameLocalDay(weekDays[selectedDayIndex]!, now)
  const mobileDayItems = byDayKey.get(selectedDayKey) ?? []
  const prevDay = useMemo(() => addLocalDays(selectedDay, -1), [selectedDay])
  const nextDay = useMemo(() => addLocalDays(selectedDay, 1), [selectedDay])
  const prevDayKey = localDayKey(prevDay)
  const nextDayKey = localDayKey(nextDay)
  const prevDayInWeek = byDayKey.has(prevDayKey)
  const nextDayInWeek = byDayKey.has(nextDayKey)
  const prevDayItems = byDayKey.get(prevDayKey) ?? []
  const nextDayItems = byDayKey.get(nextDayKey) ?? []

  const nowMinutes = now.getHours() * 60 + now.getMinutes()
  const nowTopPx = (nowMinutes / 60) * WEEK_HOUR_HEIGHT_PX
  const tzShort = useMemo(() => formatLocalTimeZoneShort(now), [now])
  const tzFull = useMemo(() => formatLocalTimeZoneFull(), [])

  const finishSettle = useCallback(
    (targetStep: ScheduleDaySwipeStep) => {
      if (settledRef.current) return
      settledRef.current = true
      clearSettleTimer()
      if (targetStep !== 0) {
        const nextTarget = addLocalDays(selectedDay, targetStep)
        setSwipedToDayKey(localDayKey(nextTarget))
        onSelectDay(nextTarget)
      }
      setSwipeState({ phase: "idle" })
    },
    [clearSettleTimer, onSelectDay, selectedDay],
  )

  const handleStripSelectDay = useCallback(
    (day: Date) => {
      clearSettleTimer()
      gestureRef.current = null
      settledRef.current = true
      setSwipedToDayKey(null)
      setSwipeState({ phase: "idle" })
      onSelectDay(day)
    },
    [clearSettleTimer, onSelectDay],
  )

  const handleSwipePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    suppressClickRef.current = false
    if (event.pointerType !== "touch" && event.pointerType !== "pen") return
    if (!event.isPrimary || swipeState.phase === "settling") return
    if (hasActiveSelection()) return

    const rect = event.currentTarget.getBoundingClientRect()
    const viewportWidth = typeof window !== "undefined" ? window.innerWidth : rect.width
    const gesture = beginScheduleDaySwipe(
      event.clientX,
      event.clientY,
      rect.width || viewportWidth || 390,
      viewportWidth,
      event.timeStamp,
    )
    if (!gesture) return
    gestureRef.current = { pointerId: event.pointerId, gesture }
  }

  const handleSwipePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const active = gestureRef.current
    if (!active || active.pointerId !== event.pointerId) return
    if (hasActiveSelection()) {
      gestureRef.current = null
      setSwipeState({ phase: "idle" })
      return
    }
    const nextGesture = advanceScheduleDaySwipe(active.gesture, event.clientX, event.clientY)
    gestureRef.current = { pointerId: active.pointerId, gesture: nextGesture }
    if (nextGesture.intent === "horizontal") {
      if (active.gesture.intent !== "horizontal") {
        suppressClickRef.current = true
        event.currentTarget.setPointerCapture?.(event.pointerId)
      }
      setSwipeState({
        phase: "dragging",
        offsetX: nextGesture.offsetX,
        containerWidth: nextGesture.containerWidth,
      })
    }
  }

  const handleSwipePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const active = gestureRef.current
    if (!active || active.pointerId !== event.pointerId) return
    gestureRef.current = null
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId)
    }

    if (active.gesture.intent !== "horizontal") {
      if (swipeState.phase !== "idle") setSwipeState({ phase: "idle" })
      return
    }

    const targetStep = finishScheduleDaySwipe(active.gesture, event.clientX, event.timeStamp)
    if (prefersReducedMotion()) {
      if (targetStep !== 0) {
        const nextTarget = addLocalDays(selectedDay, targetStep)
        setSwipedToDayKey(localDayKey(nextTarget))
        onSelectDay(nextTarget)
      }
      setSwipeState({ phase: "idle" })
      return
    }

    settledRef.current = false
    setSwipeState({ phase: "settling", targetStep })
    clearSettleTimer()
    settleTimerRef.current = window.setTimeout(() => {
      finishSettle(targetStep)
    }, SWIPE_SETTLE_FALLBACK_MS)
  }

  const handleSwipePointerCancel = (event: PointerEvent<HTMLDivElement>) => {
    const active = gestureRef.current
    if (!active || active.pointerId !== event.pointerId) return
    gestureRef.current = null
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId)
    }
    if (swipeState.phase === "dragging") {
      settledRef.current = false
      setSwipeState({ phase: "settling", targetStep: 0 })
      clearSettleTimer()
      settleTimerRef.current = window.setTimeout(() => {
        finishSettle(0)
      }, SWIPE_SETTLE_FALLBACK_MS)
    }
  }

  const handleSwipeClickCapture = (event: MouseEvent<HTMLDivElement>) => {
    if (!suppressClickRef.current) return
    suppressClickRef.current = false
    event.preventDefault()
    event.stopPropagation()
  }

  const handleTrackTransitionEnd = (event: TransitionEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || event.propertyName !== "transform") return
    if (swipeState.phase !== "settling") return
    finishSettle(swipeState.targetStep)
  }

  const showAdjacentPanes = swipeState.phase !== "idle"
  const trackTransform = swipeState.phase === "dragging"
    ? `translate3d(${swipeState.offsetX}px, 0, 0)`
    : swipeState.phase === "settling"
      ? swipeState.targetStep === 1
        ? "translate3d(-100%, 0, 0)"
        : swipeState.targetStep === -1
          ? "translate3d(100%, 0, 0)"
          : "translate3d(0px, 0, 0)"
      : undefined

  const clampedPillIndex = selectedDayIndex < 0
    ? 0
    : swipeState.phase === "dragging"
      ? Math.max(0, Math.min(6, selectedDayIndex - swipeState.offsetX / swipeState.containerWidth))
      : swipeState.phase === "settling"
        ? Math.max(0, Math.min(6, selectedDayIndex + swipeState.targetStep))
        : selectedDayIndex

  const mobileTapSlideClass = swipedToDayKey !== selectedDayKey && swipeState.phase === "idle" && direction !== 0
    ? direction > 0
      ? styles.slideFromRight
      : styles.slideFromLeft
    : undefined

  const weekSlideClass = direction > 0
    ? styles.slideFromRight
    : direction < 0
      ? styles.slideFromLeft
      : undefined

  return (
    <div data-testid={tid.scheduleWeekGrid} className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col sm:hidden">
        <div className="shrink-0 overflow-hidden border-b border-border/50 bg-background px-4 py-3">
          <div className={styles.dayStrip}>
            <div
              role="tablist"
              aria-label="Days of week"
              className={styles.dayStripTrack}
            >
              {selectedDayIndex >= 0 ? (
                <span
                  key={resolvedWeekKey}
                  aria-hidden
                  style={{
                    transform: `translate3d(calc(${clampedPillIndex} * (100% + 4px)), 0, 0)`,
                  }}
                  className={cn(
                    styles.dayStripPill,
                    isSelectedToday && styles.dayStripPillToday,
                    swipeState.phase === "dragging" && styles.dayStripPillDragging,
                  )}
                />
              ) : null}
              {weekDays.map((day, slotIndex) => {
                const key = localDayKey(day)
                const isSelected = key === selectedDayKey
                const isToday = isSameLocalDay(day, now)
                const dayItems = byDayKey.get(key) ?? []
                return (
                  <button
                    key={slotIndex}
                    type="button"
                    role="tab"
                    aria-selected={isSelected}
                    data-selected={isSelected || undefined}
                    data-today={isToday || undefined}
                    onClick={() => handleStripSelectDay(day)}
                    className={cn(
                      styles.dayKey,
                      "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                      !isSelected && isToday && "text-primary",
                    )}
                  >
                    <span className="relative z-10 text-[11px] font-medium opacity-80">
                      {formatWeekdayShort(day)}
                    </span>
                    <span className="relative z-10 font-mono text-sm leading-none font-semibold tabular-nums">
                      {day.getDate()}
                    </span>
                    <span aria-hidden className="relative z-10 flex h-1.5 items-center gap-0.5">
                      {!refreshing && dayItems.slice(0, 3).map((item) => {
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
          </div>
        </div>

        <div
          data-swipe-ignore=""
          data-schedule-swipe-surface="true"
          onPointerDown={handleSwipePointerDown}
          onPointerMove={handleSwipePointerMove}
          onPointerUp={handleSwipePointerUp}
          onPointerCancel={handleSwipePointerCancel}
          onClickCapture={handleSwipeClickCapture}
          className="relative flex min-h-0 flex-1 flex-col overflow-hidden touch-pan-y"
        >
          <div
            onTransitionEnd={handleTrackTransitionEnd}
            style={trackTransform ? { transform: trackTransform } : undefined}
            className={cn(
              "relative flex min-h-0 flex-1",
              swipeState.phase !== "idle" && "will-change-transform",
              swipeState.phase === "settling" && styles.daySwipeTrackSettling,
            )}
          >
            {showAdjacentPanes ? (
              <div aria-hidden className="pointer-events-none absolute inset-y-0 right-full flex w-full flex-col">
                <MobileDayPane
                  day={prevDay}
                  now={now}
                  items={prevDayItems}
                  refreshing={refreshing || !prevDayInWeek}
                  selectedOccurrenceKey={null}
                  onSelectOccurrence={onSelectOccurrence}
                  interactive={false}
                />
              </div>
            ) : null}

            <div className="flex min-h-0 w-full shrink-0 flex-col">
              <MobileDayPane
                key={selectedDayKey}
                day={selectedDay}
                now={now}
                items={mobileDayItems}
                refreshing={refreshing}
                selectedOccurrenceKey={selectedOccurrenceKey}
                onSelectOccurrence={onSelectOccurrence}
                interactive
                slideClassName={mobileTapSlideClass}
              />
            </div>

            {showAdjacentPanes ? (
              <div aria-hidden className="pointer-events-none absolute inset-y-0 left-full flex w-full flex-col">
                <MobileDayPane
                  day={nextDay}
                  now={now}
                  items={nextDayItems}
                  refreshing={refreshing || !nextDayInWeek}
                  selectedOccurrenceKey={null}
                  onSelectOccurrence={onSelectOccurrence}
                  interactive={false}
                />
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="hidden min-h-0 flex-1 flex-col bg-background sm:flex">
        <div className="grid shrink-0 grid-cols-[4rem_minmax(0,1fr)] overflow-hidden border-b border-border/65 bg-background">
          <div className="flex items-end justify-end border-r border-border/45 pr-2.5 pb-2 select-none">
            <span
              title={tzFull}
              className="font-mono text-[10px] leading-none font-medium tracking-wide text-muted-foreground/80"
            >
              {tzShort}
            </span>
          </div>
          <div className="relative grid grid-cols-7">
            {selectedDayIndex >= 0 ? (
              <span
                key={resolvedWeekKey}
                aria-hidden
                style={{
                  transform: `translate3d(${selectedDayIndex * 100}%, 0, 0)`,
                }}
                className={cn(
                  styles.desktopDayPillSlot,
                  isSelectedToday && "opacity-0",
                )}
              >
                <span className="size-8 rounded-full bg-muted dark:bg-white/12" />
              </span>
            ) : null}
            {weekDays.map((day, slotIndex) => {
              const key = localDayKey(day)
              const isToday = isSameLocalDay(day, now)
              const dayItems = byDayKey.get(key) ?? []
              return (
                <button
                  key={slotIndex}
                  type="button"
                  onClick={() => handleStripSelectDay(day)}
                  className={cn(
                    "relative z-10 flex flex-col items-center justify-center gap-1 border-r border-border/35 px-1.5 py-2.5 text-center transition-colors duration-150 last:border-r-0 hover:bg-muted/35 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset motion-reduce:transition-none",
                    isToday && "bg-primary/4 dark:bg-primary/7",
                  )}
                >
                  <span
                    className={cn(
                      "text-xs leading-4 font-medium",
                      isToday ? "text-primary" : "text-muted-foreground",
                    )}
                  >
                    {formatWeekdayShort(day)}
                  </span>
                  <span
                    key={resolvedWeekKey}
                    className={cn(
                      weekSlideClass,
                      "grid size-8 place-items-center rounded-full font-mono text-[15px] font-semibold tabular-nums",
                      isToday ? styles.todayDisc : "text-foreground",
                    )}
                  >
                    {day.getDate()}
                  </span>
                  <span aria-hidden className="flex h-1.5 items-center gap-1">
                    {!refreshing && dayItems.slice(0, 3).map((item) => {
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
        </div>

        <ScrollArea
          viewportRef={scrollViewportRef}
          className="min-h-0 flex-1"
          viewportClassName="size-full"
        >
          <div
            className="relative grid grid-cols-[4rem_minmax(0,1fr)] overflow-x-hidden"
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

            <div className="relative grid grid-cols-7">
              {weekDays.map((day, slotIndex) => {
                const isToday = isSameLocalDay(day, now)
                return (
                  <div
                    key={slotIndex}
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
                  </div>
                )
              })}

              <div
                key={resolvedWeekKey}
                className={cn(
                  "pointer-events-none absolute inset-0 z-20 grid grid-cols-7",
                  weekSlideClass,
                )}
              >
                {weekDays.map((day, slotIndex) => {
                  const key = localDayKey(day)
                  const blocks = refreshing
                    ? []
                    : layoutDayOccurrences(byDayKey.get(key) ?? [], day, WEEK_HOUR_HEIGHT_PX)

                  return (
                    <div key={slotIndex} className="relative">
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
                              styles.eventBlock,
                              "pointer-events-auto group absolute z-20 flex overflow-hidden rounded-lg border text-left hover:z-30 focus-visible:z-30 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                              singleLine ? "flex-row items-center gap-1.5 px-2 py-0.5" : "flex-col gap-0.5 px-2.5 py-1.5",
                              pendingAttention
                                ? "border-warning/35 bg-warning/13 hover:bg-warning/20"
                                : settled
                                  ? "border-border/80 bg-muted/75 hover:bg-muted dark:border-white/14 dark:bg-white/8 dark:hover:bg-white/12"
                                  : "border-primary/28 bg-primary/11 hover:bg-primary/17 dark:border-primary/38 dark:bg-primary/20 dark:hover:bg-primary/28",
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

              {refreshing ? <ScheduleWeekInlineSkeleton /> : null}
            </div>
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
