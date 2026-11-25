"use client"

import {
  Check,
  Pause,
  RefreshCw,
  TriangleAlertIcon,
} from "@/components/icons/lucide"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type {
  CalendarOccurrenceRunStatus,
  CalendarRecurrenceSummary,
  CalendarSourceMessage,
} from "./calendar-types"

export function CalendarRecurrenceBadge({
  recurrence,
  compact = false,
}: {
  recurrence: CalendarRecurrenceSummary
  compact?: boolean
}) {
  if (!recurrence.recurring) {
    if (compact) return null
    return (
      <Badge variant="outline" className="gap-1 border-border/80 bg-secondary/50 text-muted-foreground">
        <span>One-time</span>
      </Badge>
    )
  }
  return (
    <Badge
      variant="outline"
      className="gap-1 border-border/80 bg-secondary/70 text-foreground"
    >
      <RefreshCw className="size-3 shrink-0" aria-hidden />
      <span className="truncate">{recurrence.label}</span>
    </Badge>
  )
}

export function CalendarSourceStatusBadge({
  source,
  compact = false,
}: {
  source: CalendarSourceMessage
  compact?: boolean
}) {
  if (source.accessible) return null
  return (
    <Badge
      variant="outline"
      className="gap-1 border-warning/40 bg-warning/10 text-warning"
    >
      <TriangleAlertIcon className="size-3 shrink-0" aria-hidden />
      <span>{compact ? "Source lost" : "Source unavailable"}</span>
    </Badge>
  )
}

export function CalendarRunStatusBadge({
  status,
  paused,
  className,
}: {
  status?: CalendarOccurrenceRunStatus | null
  paused?: boolean
  className?: string
}) {
  if (paused) {
    return (
      <Badge
        variant="outline"
        className={cn("gap-1 border-border bg-muted/60 text-muted-foreground", className)}
      >
        <Pause className="size-3 shrink-0" aria-hidden />
        <span>Paused</span>
      </Badge>
    )
  }
  if (!status || status === "scheduled") return null
  switch (status) {
    case "dispatched":
      return (
        <Badge
          variant="outline"
          className={cn("gap-1 border-approval-pass/30 bg-approval-pass/10 text-approval-pass", className)}
        >
          <Check className="size-3 shrink-0" aria-hidden />
          <span>Dispatched</span>
        </Badge>
      )
    case "pending":
      return (
        <Badge
          variant="outline"
          className={cn("gap-1 border-warning/40 bg-warning/10 text-warning", className)}
        >
          <RefreshCw className="size-3 shrink-0" aria-hidden />
          <span>Pending</span>
        </Badge>
      )
    case "blocked_access":
      return (
        <Badge
          variant="outline"
          className={cn("gap-1 border-warning/40 bg-warning/10 text-warning", className)}
        >
          <TriangleAlertIcon className="size-3 shrink-0" aria-hidden />
          <span>Access blocked</span>
        </Badge>
      )
  }
}
