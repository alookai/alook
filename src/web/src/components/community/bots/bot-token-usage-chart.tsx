"use client"

import { useState } from "react"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
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
const AXIS_DAY_FMT = new Intl.DateTimeFormat(undefined, {
  month: "numeric",
  day: "numeric",
  timeZone: "UTC",
})

type MetricKey = "input" | "output" | "cache"

const METRICS: Array<{
  key: MetricKey
  label: string
  className: string
}> = [
  { key: "input", label: "Input", className: "bg-foreground/75" },
  { key: "output", label: "Output", className: "bg-muted-foreground/75" },
  { key: "cache", label: "Cache", className: "bg-foreground/25" },
]

function parseUtcDay(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`)
}

function dayLabel(day: BotUsageDay): string {
  if (day.period === "in_progress") return "Today"
  const parsed = parseUtcDay(day.day)
  return Number.isNaN(parsed.getTime()) ? day.day : AXIS_DAY_FMT.format(parsed)
}

function fullDayLabel(day: BotUsageDay): string {
  const parsed = parseUtcDay(day.day)
  return Number.isNaN(parsed.getTime()) ? day.day : DAY_FMT.format(parsed)
}

function metricTokens(metric: DailyUsageMetric): number | null {
  return metric
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
  const metrics = Object.values(day.metrics)
  const known = metrics.flatMap((metric) => {
    const tokens = metricTokens(metric)
    return tokens === null ? [] : [tokens]
  })
  const knownTotal = known.reduce((sum, tokens) => sum + tokens, 0)
  const unavailable = known.length === 0
  return {
    knownTotal,
    unavailable,
  }
}

export function normalizedBarHeight(total: number, maxTotal: number): number {
  if (total <= 0 || maxTotal <= 0) return 0
  return (total / maxTotal) * 100
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

function UsageBar({
  day,
  presentation,
  maxKnownTotal,
}: {
  day: BotUsageDay
  presentation: UsageDayPresentation
  maxKnownTotal: number
}) {
  const totalHeight = normalizedBarHeight(presentation.knownTotal, maxKnownTotal)
  return (
    <span className="relative flex min-h-0 w-full flex-1 items-end justify-center">
      <span
        className="flex w-3 flex-col-reverse overflow-hidden rounded-sm"
        style={{ height: `${totalHeight}%` }}
      >
        {METRICS.map((metric) => {
          const tokens = metricTokens(day.metrics[metric.key])
          if (!tokens || presentation.knownTotal === 0) return null
          return (
            <span
              key={metric.key}
              className={["w-full", metric.className].join(" ")}
              style={{ flexGrow: tokens }}
            />
          )
        })}
      </span>
    </span>
  )
}

export function BotTokenUsageChart({
  botId,
  usage,
  scaleMaxTokens,
}: {
  botId: string
  usage?: BotTokenUsage
  scaleMaxTokens?: number
}) {
  const [mobileOpen, setMobileOpen] = useState(false)
  const [mobileDayIndex, setMobileDayIndex] = useState(6)
  if (!usage || usage.capability !== "supported") return null

  const presentations = usage.days.map(usageDayPresentation)
  const maxKnownTotal = scaleMaxTokens
    ?? Math.max(0, ...presentations.map((day) => day.knownTotal))

  return (
    <section
      aria-label="Token usage over the last 7 days"
      data-testid={tid.botUsage(botId)}
      className="h-10.5 w-32 max-w-full"
    >
      <div className="relative grid h-full min-h-0 grid-cols-7 gap-1" role="list">
        {usage.days.map((day, index) => {
          const presentation = presentations[index]!
          return (
            <Tooltip key={day.day}>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    role="listitem"
                    aria-label={accessibleDayLabel(day)}
                    data-testid={tid.botUsageDay(botId, day.day)}
                    className="group hidden min-w-0 flex-col items-center gap-1 rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:flex"
                  >
                    <UsageBar day={day} presentation={presentation} maxKnownTotal={maxKnownTotal} />
                  </button>
                }
              />
              <TooltipContent className="items-start">
                <UsageDayDetail day={day} />
              </TooltipContent>
            </Tooltip>
          )
        })}
        {usage.days.map((day, index) => (
          <div
            key={`mobile-${day.day}`}
            role="listitem"
            aria-label={accessibleDayLabel(day)}
            className="group flex min-w-0 flex-col items-center gap-1 sm:hidden"
          >
            <UsageBar day={day} presentation={presentations[index]!} maxKnownTotal={maxKnownTotal} />
          </div>
        ))}
        <Popover open={mobileOpen} onOpenChange={setMobileOpen}>
          <PopoverTrigger
            render={
              <button
                type="button"
                aria-label="Open token usage details"
                aria-expanded={mobileOpen}
                className="absolute inset-0 z-10 min-h-11 rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:hidden"
              />
            }
          />
          <PopoverContent
            side="bottom"
            align="end"
            className="max-h-[calc(100vh-2rem)] w-72 max-w-[calc(100vw-1rem)] overflow-y-auto p-3 thin-scrollbar sm:hidden"
          >
            <div className="flex flex-col gap-3">
              <div className="text-xs text-foreground">
                <UsageDayDetail day={usage.days[mobileDayIndex] ?? usage.days.at(-1)!} />
              </div>
              <div className="grid grid-cols-4 gap-2 border-t border-border/60 pt-2">
                {usage.days.map((day, index) => (
                  <button
                    key={day.day}
                    type="button"
                    data-testid={tid.botUsageDay(botId, day.day)}
                    aria-pressed={index === mobileDayIndex}
                    onClick={() => setMobileDayIndex(index)}
                    className="flex h-11 min-w-11 items-center justify-center rounded-md px-1 text-center text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none aria-pressed:bg-accent aria-pressed:font-semibold aria-pressed:text-foreground"
                  >
                    <span>{dayLabel(day)}</span>
                  </button>
                ))}
              </div>
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </section>
  )
}
