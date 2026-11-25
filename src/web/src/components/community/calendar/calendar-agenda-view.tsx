"use client"

import { useMemo } from "react"
import { CalendarDays, ExternalLink } from "@/components/icons/lucide"
import { EmptyState } from "@/components/community/empty-state"
import { tid } from "@/lib/community/testids"
import { cn } from "@/lib/utils"
import { CalendarActorAvatar } from "./calendar-actor"
import {
  formatAgendaDayLabel,
  formatTimeRange,
  groupOccurrencesByDay,
} from "./calendar-date"
import {
  CalendarRecurrenceBadge,
  CalendarRunStatusBadge,
  CalendarSourceStatusBadge,
  CalendarStatusDot,
} from "./calendar-status"
import type { CalendarOccurrenceItem } from "./calendar-types"

export function CalendarAgendaView({
  occurrences,
  selectedOccurrenceKey,
  onSelectOccurrence,
  emptyLabel = "No upcoming events in this range. Ask a bot to schedule a reminder from any message.",
}: {
  occurrences: readonly CalendarOccurrenceItem[]
  selectedOccurrenceKey: string | null
  onSelectOccurrence: (occurrence: CalendarOccurrenceItem) => void
  emptyLabel?: string
}) {
  const now = useMemo(() => new Date(), [])
  const groups = useMemo(() => groupOccurrencesByDay(occurrences), [occurrences])

  if (groups.length === 0) {
    return (
      <div
        data-testid={tid.calendarAgenda}
        className="flex flex-1 flex-col items-center justify-center rounded-2xl border border-border/70 bg-card/60 py-16"
      >
        <EmptyState icon={CalendarDays} label={emptyLabel} />
      </div>
    )
  }

  return (
    <div data-testid={tid.calendarAgenda} className="flex flex-col gap-6 sm:gap-7">
      {groups.map((group) => {
        const heading = formatAgendaDayLabel(group.date, now)
        return (
          <section
            key={group.dayKey}
            aria-label={`${heading.primary} ${heading.secondary}`}
            className="grid min-w-0 gap-3 sm:grid-cols-[9.5rem_minmax(0,1fr)] sm:gap-5"
          >
            <div className="flex items-baseline gap-2 sm:flex-col sm:gap-0.5 sm:pt-3">
              <h2
                className={cn(
                  "text-sm font-semibold",
                  heading.isToday ? "text-primary" : "text-foreground",
                )}
              >
                {heading.primary}
              </h2>
              <span className="font-mono text-xs tabular-nums text-muted-foreground">
                {heading.secondary}
              </span>
            </div>

            <div className="flex min-w-0 flex-col gap-2.5">
              {group.items.map((occurrence) => {
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
                      "flex min-h-11 w-full flex-col gap-2.5 rounded-xl border bg-card p-3.5 text-left transition-colors duration-150 hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none motion-reduce:transition-none sm:p-4",
                      degraded
                        ? "border-warning/35 bg-warning/6 hover:bg-warning/10"
                        : event.paused
                          ? "border-dashed border-border/80 opacity-80"
                          : "border-border/80",
                      selectedOccurrenceKey === occurrence.occurrenceKey && "ring-2 ring-ring",
                    )}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="flex items-center gap-2 font-mono text-xs font-medium tabular-nums text-muted-foreground">
                        <CalendarStatusDot status={runStatus} paused={event.paused} degraded={degraded} />
                        <span>{formatTimeRange(occurrence.startAt, occurrence.endAt)}</span>
                      </span>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <CalendarRecurrenceBadge recurrence={event.recurrence} />
                        <CalendarSourceStatusBadge source={event.sourceMessage} runStatus={runStatus} />
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

                    <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5 text-xs text-muted-foreground">
                      <span className="flex min-w-0 items-center gap-2">
                        <CalendarActorAvatar actor={event.creator} size={20} />
                        <span className="truncate font-medium text-foreground/85">
                          {event.creator.name}
                        </span>
                      </span>
                      {event.sourceMessage.accessible ? (
                        <span className="inline-flex min-w-0 items-center gap-1 text-muted-foreground">
                          <ExternalLink className="size-3 shrink-0" aria-hidden />
                          <span className="truncate">
                            {event.sourceMessage.channelLabel ?? "Bound message"}
                          </span>
                        </span>
                      ) : null}
                    </div>
                  </button>
                )
              })}
            </div>
          </section>
        )
      })}
    </div>
  )
}
