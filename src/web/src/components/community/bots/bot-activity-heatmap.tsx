"use client"

import { useMemo } from "react"
import { utcDayKeyDaysAgo } from "@alook/shared"

// One day's activity for a bot: post-gate messages handled + messages the bot
// sent. Both counts are non-negative integers; a day with no activity is 0/0.
// Field names match the backend rollup contract (Cecilia /Gus/working #617):
// `{ day, handledCount, sentCount }[]`, past 30 days, missing days padded 0.
// A brand-new bot returns [] (normal, not an error) — we render 30 empty cells.
export type BotActivityDay = {
  // Calendar day, "YYYY-MM-DD".
  day: string
  handledCount: number
  sentCount: number
}

// Gus asked for "past 30 days" (Gus /Gus/uiux #608). Responsive layout is set
// in the grid classes below: mobile = full-width 3×10 ribbon, desktop = a thin
// 4-row strip on the card's right. Cells flow column-by-column (grid-flow-col),
// like a GitHub contribution graph. 30 divides both row counts → flush columns.
const WINDOW_DAYS = 30

// Intensity buckets (0 = no activity, then four filled steps like GitHub).
// The fill is `--status-online` (the "alive/online" green already on this
// card's Online pill — Alli /Gus/uiux #154) at rising strength, so "active"
// and "alive" speak the same color and it reads in both themes without a
// bespoke palette. Bucket 0 is a faint track cell (also the all-zero state).
const BUCKET_CLASSES = [
  "bg-muted-foreground/15", // 0 — no activity / empty day
  "bg-status-online/30",
  "bg-status-online/55",
  "bg-status-online/80",
  "bg-status-online", // busiest
] as const

const DATE_FMT = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" })

function bucketFor(total: number, max: number): number {
  if (total <= 0 || max <= 0) return 0
  // Map (0, max] onto buckets 1..4 by quartile of the observed max, so a quiet
  // month still shows contrast instead of collapsing to a single step (Alli
  // #628 adopted this relative scale over absolute thresholds).
  const ratio = total / max
  if (ratio > 0.75) return 4
  if (ratio > 0.5) return 3
  if (ratio > 0.25) return 2
  return 1
}

function tooltipFor(day: BotActivityDay): string {
  const d = new Date(`${day.day}T00:00:00`)
  const label = Number.isNaN(d.getTime()) ? day.day : DATE_FMT.format(d)
  return `${label} · ${day.handledCount} handled · ${day.sentCount} sent`
}

/**
 * BotActivityHeatmap — compact contribution grid for the bot card.
 *
 * Design (Gus /Gus/uiux #155, refining Alli #154): a compact, variable-size
 * grid — NOT a fixed block forced onto every card, NO Less→More legend, and
 * uniform x/y spacing (equal gap both axes). Each cell's tint encodes total
 * activity (handled + sent) for that day; the tooltip splits the two numbers
 * ("Jul 17 · 12 handled · 4 sent"). Placement is the card's job (desktop: the
 * card's empty right side; mobile: below the meta line) — this component only
 * owns the grid and stays placement-agnostic.
 *
 * Data shape is the locked frontend contract (Claudette /Gus/working #663):
 * `dailyActivity: { day, handledCount, sentCount }[]`, oldest→newest, ONLY days
 * with activity (sparse — backend does NOT pad), new bot = []. We build the full
 * 30-day UTC calendar and fill from the sparse rows by day-key, so gaps and empty
 * bots both render as bucket-0 cells and the grid is always exactly 30.
 */
// The card renders two instances — the desktop strip (on the card's right) and
// the mobile ribbon (below the meta line) live in different DOM spots, so each
// picks its layout by `variant` and hides at the other breakpoint. `className`
// lets the card apply that `hidden`/`sm:hidden` visibility wrapper.
export function BotActivityHeatmap({
  days,
  variant,
  className,
}: {
  days: BotActivityDay[]
  variant: "desktop" | "mobile"
  className?: string
}) {
  const cells = useMemo(() => {
    // The backend returns ONLY days with activity (sparse, Claudette #663) — it
    // does NOT pad. So we can't pad by count; we build the full WINDOW_DAYS
    // calendar (today back, in UTC to match the backend's utcDayKey) and fill
    // each slot from the sparse map by day-key. Missing days → bucket 0.
    const byDay = new Map(days.map((d) => [d.day, d]))
    const now = new Date()
    // Oldest→newest: slot i counts back (WINDOW_DAYS-1-i) days from today, so
    // the last cell is today and the first is 29 days ago. utcDayKeyDaysAgo is
    // the SAME shared helper the backend's read + upserts use (Claudette #669) —
    // one function, so the front-end axis and the backend `day` strings can't
    // drift apart on the UTC boundary.
    const axisKeys = Array.from({ length: WINDOW_DAYS }, (_, i) =>
      utcDayKeyDaysAgo(now, WINDOW_DAYS - 1 - i),
    )
    const max = days.reduce((m, d) => Math.max(m, d.handledCount + d.sentCount), 0)
    // Key by calendar day (stable across renders), not grid index.
    return axisKeys.map((key) => {
      const d = byDay.get(key)
      if (!d) return { key, bucket: 0, title: undefined as string | undefined }
      return {
        key,
        bucket: bucketFor(d.handledCount + d.sentCount, max),
        title: tooltipFor(d),
      }
    })
  }, [days])

  const total = useMemo(
    () => days.reduce((s, d) => s + d.handledCount + d.sentCount, 0),
    [days],
  )

  // Cells flow column-by-column (grid-flow-col), so the 30-day sequence reads
  // down each column like a GitHub graph. Always exactly 30 cells into a row
  // count that divides 30 → complete columns, flush bottom edge (#159). Uniform
  // x/y gap both variants (Gus /Gus/uiux #155). Two layouts:
  //   • mobile: FULL-WIDTH horizontal ribbon (Gus #164/#165) — 3 rows × 10
  //     columns; 10 1fr columns span the card, cells auto-size square to the
  //     column width so the ribbon always fills the card, left/right flush.
  //   • desktop: a thin fixed-size strip in the card's empty right side
  //     (#155/#165) — 4 rows, auto columns, small size-2 cells, w-fit.
  const isMobile = variant === "mobile"
  return (
    <div
      role="img"
      aria-label={`Activity over the last ${WINDOW_DAYS} days: ${total} messages total`}
      className={[
        "grid grid-flow-col gap-[3px]",
        isMobile
          ? "w-full [grid-template-columns:repeat(10,minmax(0,1fr))] [grid-template-rows:repeat(3,auto)]"
          : "w-fit [grid-template-rows:repeat(4,minmax(0,1fr))]",
        className ?? "",
      ].join(" ")}
    >
      {cells.map((c) => (
        <span
          key={c.key}
          title={c.title}
          className={[
            "rounded-[2px]",
            isMobile ? "aspect-square w-full" : "size-2",
            BUCKET_CLASSES[c.bucket],
          ].join(" ")}
        />
      ))}
    </div>
  )
}
