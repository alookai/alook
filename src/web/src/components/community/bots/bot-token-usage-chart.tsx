"use client"

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
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

function UsageDayDetail({ day }: { day: BotUsageDay }) {
  return (
    <span className="flex min-w-44 flex-col gap-1">
      <span className="font-medium">{fullDayLabel(day)}</span>
      {METRICS.map((metric) => (
        <span key={metric.key} className="flex items-center justify-between gap-4">
          <span>{metric.label}</span>
          <span className="font-mono tabular-nums">{metricLabel(day.metrics[metric.key])}</span>
        </span>
      ))}
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
  if (!usage || usage.capability !== "supported") return null

  const total = usage.days.reduce(
    (sum, day) => sum + usageDayPresentation(day).knownTotal,
    0,
  )

  return (
    <div
      role="img"
      aria-label={`Token usage over the last 30 days: ${TOKEN_FMT.format(total)} known tokens total`}
      data-testid={tid.botUsage(botId)}
      className={[
        "grid w-fit grid-flow-col gap-[3px] [grid-template-rows:repeat(3,minmax(0,1fr))]",
        className ?? "",
      ].join(" ")}
    >
      {usage.days.map((day) => {
        const bucket = tokenHeatBucket(usageDayPresentation(day))
        return (
          <Tooltip key={day.day}>
            <TooltipTrigger
              render={
                <span
                  aria-label={accessibleDayLabel(day)}
                  data-testid={tid.botUsageDay(botId, day.day)}
                  className={["size-3 rounded-[2px]", BUCKET_CLASSES[bucket]].join(" ")}
                />
              }
            />
            <TooltipContent className="items-start">
              <UsageDayDetail day={day} />
            </TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}
