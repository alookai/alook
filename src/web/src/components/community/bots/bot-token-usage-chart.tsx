"use client"

import { useEffect, useRef, useState } from "react"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { useBreakpoint } from "@/hooks/use-mobile"
import { tid } from "@/lib/community/testids"
import type { BotTokenUsage, BotUsageDay } from "@/hooks/community/use-bots"
import type { DailyUsageMetric } from "@alook/shared"

const TOKEN_FMT = new Intl.NumberFormat(undefined)
const DAY_FMT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
})

const BUCKET_CLASSES = [
  "bg-muted-foreground/15",
  "bg-status-online/30",
  "bg-status-online/55",
  "bg-status-online/80",
  "bg-status-online",
] as const

type MetricKey = "input" | "output" | "cache"

const METRICS: Array<{
  key: MetricKey
  label: string
}> = [
  { key: "input", label: "Input" },
  { key: "output", label: "Output" },
  { key: "cache", label: "Cache" },
]

function parseUtcDay(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`)
}

function fullDayLabel(day: BotUsageDay): string {
  const parsed = parseUtcDay(day.day)
  return Number.isNaN(parsed.getTime()) ? day.day : DAY_FMT.format(parsed)
}

function metricLabel(metric: DailyUsageMetric): string {
  if (metric === null) return "Unavailable"
  return TOKEN_FMT.format(metric)
}

export type UsageDayPresentation = {
  knownTotal: number
  unavailable: boolean
}

export function usageDayPresentation(day: BotUsageDay): UsageDayPresentation {
  const known = Object.values(day.metrics).filter(
    (metric): metric is number => metric !== null,
  )
  return {
    knownTotal: known.reduce((sum, tokens) => sum + tokens, 0),
    unavailable: known.length === 0,
  }
}

export function tokenHeatBucket(presentation: UsageDayPresentation): number {
  if (presentation.unavailable || presentation.knownTotal <= 0) return 0
  if (presentation.knownTotal < 10_000_000) return 1
  if (presentation.knownTotal < 100_000_000) return 2
  if (presentation.knownTotal < 500_000_000) return 3
  return 4
}

function accessibleDayLabel(day: BotUsageDay): string {
  return [
    fullDayLabel(day),
    `Input ${metricLabel(day.metrics.input)}`,
    `Output ${metricLabel(day.metrics.output)}`,
    `Cache ${metricLabel(day.metrics.cache)}`,
  ].join(". ")
}

function UsageDayDetail({ day, includeTotal = false }: { day: BotUsageDay; includeTotal?: boolean }) {
  const presentation = usageDayPresentation(day)
  return (
    <span className="flex min-w-44 flex-col gap-1">
      <span className="font-medium">{fullDayLabel(day)}</span>
      {includeTotal && (
        <span className="flex items-center justify-between gap-4 font-medium">
          <span>Total</span>
          <span className="font-mono tabular-nums">
            {presentation.unavailable ? "Unavailable" : TOKEN_FMT.format(presentation.knownTotal)}
          </span>
        </span>
      )}
      {METRICS.map((metric) => (
        <span key={metric.key} className="flex items-center justify-between gap-4">
          <span>{metric.label}</span>
          <span className="font-mono tabular-nums">{metricLabel(day.metrics[metric.key])}</span>
        </span>
      ))}
    </span>
  )
}

function UsageHeatmapGrid({
  botId,
  days,
  interactive,
  ariaLabel,
  className,
}: {
  botId: string
  days: BotUsageDay[]
  interactive: boolean
  ariaLabel?: string
  className?: string
}) {
  return (
    <span
      role={interactive ? "img" : undefined}
      aria-label={interactive ? ariaLabel : undefined}
      aria-hidden={interactive ? undefined : true}
      data-testid={tid.botUsage(botId)}
      className={[
        "grid w-fit grid-flow-col gap-[3px] [grid-template-rows:repeat(3,minmax(0,1fr))]",
        className ?? "",
      ].join(" ")}
    >
      {days.map((day) => {
        const bucket = tokenHeatBucket(usageDayPresentation(day))
        const cell = (
          <span
            key={day.day}
            aria-label={interactive ? accessibleDayLabel(day) : undefined}
            data-testid={tid.botUsageDay(botId, day.day)}
            className={["size-3 rounded-[2px]", BUCKET_CLASSES[bucket]].join(" ")}
          />
        )
        if (!interactive) return cell
        return (
          <Tooltip key={day.day}>
            <TooltipTrigger render={cell} />
            <TooltipContent className="items-start">
              <UsageDayDetail day={day} />
            </TooltipContent>
          </Tooltip>
        )
      })}
    </span>
  )
}

export function BotTokenUsageHeatmap({
  botId,
  usage,
  className,
}: {
  botId: string
  usage?: BotTokenUsage
  className?: string
}) {
  const breakpoint = useBreakpoint()
  const newestDay = usage?.capability === "supported" ? usage.days.at(-1) : undefined
  const [open, setOpen] = useState(false)
  const [selectedDayKey, setSelectedDayKey] = useState(newestDay?.day ?? "")
  const dateRailRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!newestDay || usage?.days.some((day) => day.day === selectedDayKey)) return
    setSelectedDayKey(newestDay.day)
  }, [newestDay, selectedDayKey, usage])

  useEffect(() => {
    if (breakpoint !== "mobile") setOpen(false)
  }, [breakpoint])

  useEffect(() => {
    if (!open || !dateRailRef.current) return
    dateRailRef.current.scrollLeft = dateRailRef.current.scrollWidth
  }, [open])

  if (!usage || usage.capability !== "supported") return null

  const total = usage.days.reduce(
    (sum, day) => sum + usageDayPresentation(day).knownTotal,
    0,
  )
  const ariaLabel = `Token usage over the last 30 days: ${TOKEN_FMT.format(total)} known tokens total`

  if (breakpoint === "mobile") {
    const selectedDay = usage.days.find((day) => day.day === selectedDayKey) ?? newestDay
    return (
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (nextOpen && newestDay) setSelectedDayKey(newestDay.day)
          setOpen(nextOpen)
        }}
      >
        <DialogTrigger
          render={
            <button
              type="button"
              aria-label="Open token usage details"
              aria-haspopup="dialog"
              data-testid={tid.botUsageTrigger(botId)}
              className={[
                "grid min-h-11 place-items-center rounded-md px-1 outline-none active:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                className ?? "",
              ].join(" ")}
            />
          }
        >
          <UsageHeatmapGrid botId={botId} days={usage.days} interactive={false} />
        </DialogTrigger>
        <DialogContent data-testid={tid.botUsageDialog(botId)} className="gap-4">
          <DialogHeader>
            <DialogTitle>Token usage</DialogTitle>
            <DialogDescription>Choose a date to view exact token totals.</DialogDescription>
          </DialogHeader>
          <div
            ref={dateRailRef}
            data-testid={tid.botUsageDateRail(botId)}
            className="-mx-1 flex min-w-0 gap-2 overflow-x-auto px-1 pb-1 overscroll-x-contain thin-scrollbar scrollbar-none"
          >
            {usage.days.map((day) => {
              const selected = day.day === selectedDay?.day
              return (
                <button
                  key={day.day}
                  type="button"
                  aria-pressed={selected}
                  data-testid={tid.botUsageDialogDay(botId, day.day)}
                  className={[
                    "h-11 shrink-0 whitespace-nowrap rounded-md border px-3 text-sm outline-none active:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                    selected
                      ? "border-foreground bg-foreground font-medium text-background"
                      : "border-border bg-background text-muted-foreground hover:bg-accent hover:text-foreground",
                  ].join(" ")}
                  onClick={() => setSelectedDayKey(day.day)}
                >
                  {fullDayLabel(day)}
                </button>
              )
            })}
          </div>
          {selectedDay && (
            <div
              aria-live="polite"
              data-testid={tid.botUsageDialogSummary(botId)}
              className="border-t pt-4"
            >
              <UsageDayDetail day={selectedDay} includeTotal />
            </div>
          )}
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <UsageHeatmapGrid
      botId={botId}
      days={usage.days}
      interactive
      ariaLabel={ariaLabel}
      className={className}
    />
  )
}
