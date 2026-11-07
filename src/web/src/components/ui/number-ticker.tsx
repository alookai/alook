"use client"

import NumberFlow, { type Value } from "@number-flow/react"
import { cn } from "@/lib/utils"

export function NumberTicker({
  value,
  decimals = 0,
  compact = false,
  className,
  duration,
}: {
  value: Value

  decimals?: number

  compact?: boolean
  className?: string
  duration?: number
}) {
  return (
    <NumberFlow
      value={value}
      isolate
      {...(duration === undefined ? {} : {
        transformTiming: { duration, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
        opacityTiming: { duration: Math.min(duration, 160), easing: "ease-out" },
      })}
      format={{
        notation: compact ? "compact" : "standard",
        compactDisplay: "short",
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      }}
      className={cn("tabular-nums", className)}
    />
  )
}
