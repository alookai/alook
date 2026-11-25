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
        className="flex flex-1 flex-col items-center justify-center rounded-xl border border-border/60 bg-card/50 py-16"
      >
        <EmptyState icon={CalendarDays} label={emptyLabel} />
      </div>
    )
  }

  return (
    <div data-testid={tid.calendarAgenda} className="flex flex-col gap-8">
      {groups.map((group) => {
        const heading = formatAgendaDayLabel(group.date, now)
        return (
          <section
            key={group.dayKey}
            aria-label={`${heading.primary} ${heading.secondary}`}
            className="grid min-w-0 gap-4 sm:grid-cols-[11rem_minmax(0,1fr)]"
          >
            <div className="flex items-baseline gap-2 sm:flex-col sm:gap-1 sm:pt-2">
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

            <div className="flex min-w-0 flex-col gap-3">
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
                      "flex min-h-11 w-full flex-col gap-3 rounded-lg border border-border/70 border-l-2 bg-card p-4 text-left shadow-(--e1) transition-colors duration-150 hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none motion-reduce:transition-none",
                      degraded
                        ? "border-l-warning"
                        : event.paused
                          ? "border-l-muted-foreground/50 opacity-80"
                          : "border-l-primary",
                      selectedOccurrenceKey === occurrence.occurrenceKey && "ring-2 ring-ring",
                    )}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-mono text-xs font-medium tabular-nums text-muted-foreground">
                        {formatTimeRange(occurrence.startAt, occurrence.endAt)}
                      </span>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <CalendarRecurrenceBadge recurrence={event.recurrence} />
                        <CalendarSourceStatusBadge source={event.sourceMessage} />
                        <CalendarRunStatusBadge status={runStatus} paused={event.paused} />
                      </div>
                    </div>

                    <div className="flex min-w-0 flex-col gap-1">
                      <div className="text-sm font-medium text-foreground">{event.title}</div>
                      {event.description ? (
                        <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                          {event.description}
                        </p>
                      ) : null}
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-xs text-muted-foreground">
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
