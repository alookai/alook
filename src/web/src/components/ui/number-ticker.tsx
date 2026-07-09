"use client"

import NumberFlow, { type Value } from "@number-flow/react"
import { cn } from "@/lib/utils"

/**
 * Animated numeric ticker. Digits transition with a slot-machine slide when
 * the value changes. Locale-aware formatting (thousands separators, decimals,
 * compact notation) is handed off to Intl.NumberFormat under the hood.
 *
 * Use this anywhere a number can change while it's on screen — reaction
 * counts, unread badges, live totals, the scroll-down indicator, etc.
 * A static number does not need this component; render the value directly.
 *
 * @example
 * <NumberTicker value={12} />                          // "12"
 * <NumberTicker value={1234} />                        // "1,234"
 * <NumberTicker value={4200} compact />                // "4.2K"
 * <NumberTicker value={0.75} decimals={2} />           // "0.75"
 */
export function NumberTicker({
  value,
  decimals = 0,
  compact = false,
  className,
}: {
  value: Value
  /** Fixed number of fraction digits. Defaults to 0 (integer display). */
  decimals?: number
  /** Compact notation — 1_500 → "1.5K", 1_200_000 → "1.2M". */
  compact?: boolean
  className?: string
}) {
  return (
    <NumberFlow
      value={value}
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
