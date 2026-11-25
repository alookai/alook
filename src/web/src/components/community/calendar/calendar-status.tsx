"use client"

import {
  Check,
  RefreshCw,
  TriangleAlertIcon,
} from "@/components/icons/lucide"
import { cn } from "@/lib/utils"
import type {
  CalendarOccurrenceRunStatus,
  CalendarRecurrenceSummary,
  CalendarSourceMessage,
} from "./calendar-types"

const PILL_BASE_CLASS =
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium leading-4 whitespace-nowrap"

export function CalendarStatusDot({
  status,
  degraded,
  size = "md",
  className,
}: {
  status?: CalendarOccurrenceRunStatus | null
  degraded?: boolean
  size?: "sm" | "md"
  className?: string
}) {
  const toneClass = degraded || status === "blocked_access"
    ? "bg-warning"
    : status === "completed"
      ? "bg-approval-pass"
      : status === "pending"
        ? "bg-warning"
        : "bg-primary"

  return (
    <span
      aria-hidden
      className={cn(
        "shrink-0 rounded-full",
        size === "sm" ? "size-1.5" : "size-2",
        toneClass,
        className,
      )}
    />
  )
}

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
      <span className={cn(PILL_BASE_CLASS, "bg-muted text-muted-foreground")}>
        One-time
      </span>
    )
  }
  return (
    <span className={cn(PILL_BASE_CLASS, "bg-muted text-foreground/85")}>
      <RefreshCw className="size-3 shrink-0 text-muted-foreground" aria-hidden />
      <span className="truncate">{recurrence.label}</span>
    </span>
  )
}

export function CalendarSourceStatusBadge({
  source,
  runStatus,
  compact = false,
}: {
  source: CalendarSourceMessage
  runStatus?: CalendarOccurrenceRunStatus | null
  compact?: boolean
}) {
  if (source.accessible) return null
  if (runStatus === "blocked_access") return null
  return (
    <span className={cn(PILL_BASE_CLASS, "bg-warning/14 text-warning")}>
      <TriangleAlertIcon className="size-3 shrink-0" aria-hidden />
      <span>{compact ? "Source lost" : "Source unavailable"}</span>
    </span>
  )
}

export function CalendarRunStatusBadge({
  status,
  className,
}: {
  status?: CalendarOccurrenceRunStatus | null
  className?: string
}) {
  if (!status || status === "scheduled") return null
  switch (status) {
    case "completed":
      return (
        <span className={cn(PILL_BASE_CLASS, "bg-approval-pass/12 text-approval-pass", className)}>
          <Check className="size-3 shrink-0" aria-hidden />
          <span>Completed</span>
        </span>
      )
    case "dispatched":
      return (
        <span className={cn(PILL_BASE_CLASS, "bg-primary/12 text-primary", className)}>
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-primary" />
          <span>Dispatched</span>
        </span>
      )
    case "pending":
      return (
        <span className={cn(PILL_BASE_CLASS, "bg-warning/14 text-warning", className)}>
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warning" />
          <span>Pending</span>
        </span>
      )
    case "blocked_access":
      return (
        <span className={cn(PILL_BASE_CLASS, "bg-warning/14 text-warning", className)}>
          <TriangleAlertIcon className="size-3 shrink-0" aria-hidden />
          <span>Access blocked</span>
        </span>
      )
  }
}
