"use client"

import { useMemo } from "react"
import { motion } from "motion/react"
import { CalendarDays } from "@/components/icons/lucide"
import { EmptyState } from "@/components/community/empty-state"
import { ScrollArea } from "@/components/ui/scroll-area"
import { tid } from "@/lib/community/testids"
import { cn } from "@/lib/utils"
import { ScheduleActorAvatar } from "./schedule-actor"
import {
  formatAgendaDayLabel,
  formatTimeRange,
  formatWeekdayShort,
  groupOccurrencesByDay,
} from "./schedule-date"
import { ScheduleAgendaInlineSkeleton } from "./schedule-skeleton"
import {
  ScheduleRecurrenceBadge,
  ScheduleRunStatusBadge,
  ScheduleSourceRefPill,
  ScheduleSourceStatusBadge,
  ScheduleStatusDot,
} from "./schedule-status"
import type { ScheduleOccurrenceItem } from "./schedule-types"
import styles from "./schedule.module.css"

const EASE_OUT_EXPO: [number, number, number, number] = [0.16, 1, 0.3, 1]

export function ScheduleAgendaView({
  rangeKey,
  direction = 0,
  refreshing = false,
  occurrences,
  selectedOccurrenceKey,
  onSelectOccurrence,
  emptyLabel = "No scheduled tasks in this range. Ask a bot to set up a schedule.",
}: {
  rangeKey?: string
  direction?: -1 | 0 | 1
  refreshing?: boolean
  occurrences: readonly ScheduleOccurrenceItem[]
  selectedOccurrenceKey: string | null
  onSelectOccurrence: (occurrence: ScheduleOccurrenceItem) => void
  emptyLabel?: string
}) {
  const now = useMemo(() => new Date(), [])
  const groups = useMemo(() => groupOccurrencesByDay(occurrences), [occurrences])

  return (
    <ScrollArea className="min-h-0 flex-1 bg-background" contentClassName="flex min-h-full flex-col">
      {refreshing ? (
        <div data-testid={tid.scheduleAgenda} className="flex flex-1 flex-col">
          <ScheduleAgendaInlineSkeleton />
        </div>
      ) : groups.length === 0 ? (
        <motion.div
          key={`empty:${rangeKey ?? "default"}`}
          initial={{ opacity: 0, y: direction * 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2, ease: EASE_OUT_EXPO }}
          data-testid={tid.scheduleAgenda}
          className="flex flex-1 flex-col items-center justify-center px-6 py-16"
        >
          <EmptyState icon={CalendarDays} label={emptyLabel} />
        </motion.div>
      ) : (
        <motion.div
          key={rangeKey ?? "agenda"}
          initial={{ opacity: 0.4, y: direction * 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2, ease: EASE_OUT_EXPO }}
          data-testid={tid.scheduleAgenda}
          className="flex flex-col divide-y divide-border/50 pb-6"
        >
          {groups.map((group, groupIndex) => {
            const heading = formatAgendaDayLabel(group.date, now)
            const monthShort = new Intl.DateTimeFormat(undefined, { month: "short" }).format(group.date)
            return (
              <motion.section
                key={group.dayKey}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.19, delay: Math.min(groupIndex * 0.03, 0.14), ease: EASE_OUT_EXPO }}
                aria-label={`${heading.primary} ${heading.secondary}`}
                className="grid min-w-0 gap-2 px-4 py-4 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-6 sm:px-6 sm:py-5"
              >
                <div className="flex items-center gap-3 sm:items-start sm:pt-2.5">
                  <div
                    className={cn(
                      "grid size-9 shrink-0 place-items-center rounded-full font-mono text-base font-semibold tabular-nums",
                      heading.isToday
                        ? styles.todayDisc
                        : "bg-muted text-foreground",
                    )}
                  >
                    {group.date.getDate()}
                  </div>
                  <div className="flex min-w-0 flex-col">
                    <h2
                      className={cn(
                        "text-sm leading-tight font-semibold",
                        heading.isToday ? "text-primary" : "text-foreground",
                      )}
                    >
                      {heading.primary}
                    </h2>
                    <span className="font-mono text-xs tabular-nums text-muted-foreground">
                      {formatWeekdayShort(group.date)}, {monthShort}
                    </span>
                  </div>
                </div>

                <div className="flex min-w-0 flex-col divide-y divide-border/40">
                  {group.items.map((occurrence) => {
                    const { event } = occurrence
                    const runStatus = occurrence.runStatus ?? event.lastExecution?.status ?? null
                    const degraded = !event.sourceMessage.accessible || runStatus === "blocked_access"
                    return (
                      <div key={occurrence.occurrenceKey} className="py-1 first:pt-0 last:pb-0">
                        <div
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
                            "-mx-3 flex min-h-11 w-[calc(100%+1.5rem)] cursor-pointer flex-col gap-2 rounded-xl px-3 py-2.5 text-left hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:py-3",
                            degraded && "bg-warning/6 hover:bg-warning/11",
                            selectedOccurrenceKey === occurrence.occurrenceKey && "bg-muted/65 ring-1 ring-ring/50",
                          )}
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="flex items-center gap-2 font-mono text-xs font-medium tabular-nums text-muted-foreground">
                              <ScheduleStatusDot status={runStatus} degraded={degraded} />
                              <span>{formatTimeRange(occurrence.startAt, occurrence.endAt)}</span>
                            </span>
                            <div className="flex flex-wrap items-center gap-1.5">
                              <ScheduleRecurrenceBadge recurrence={event.recurrence} />
                              <ScheduleSourceStatusBadge source={event.sourceMessage} runStatus={runStatus} />
                              <ScheduleRunStatusBadge status={runStatus} />
                            </div>
                          </div>

                          <div className="flex min-w-0 flex-col gap-1">
                            <div className="text-sm leading-snug font-medium text-foreground">{event.title}</div>
                            {event.description ? (
                              <p className="max-w-[68ch] line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                                {event.description}
                              </p>
                            ) : null}
                          </div>

                          <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5 text-xs text-muted-foreground">
                            <span className="flex min-w-0 items-center gap-2">
                              <ScheduleActorAvatar actor={event.creator} size={18} />
                              <span className="truncate font-medium text-foreground/85">
                                {event.creator.name}
                              </span>
                            </span>
                            <ScheduleSourceRefPill source={event.sourceMessage} />
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </motion.section>
            )
          })}
        </motion.div>
      )}
    </ScrollArea>
  )
}
