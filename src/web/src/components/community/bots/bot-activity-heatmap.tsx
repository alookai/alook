"use client"

import { useMemo } from "react"
import { utcDayKeyDaysAgo } from "@alook/shared"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

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

// ABSOLUTE per-day thresholds (Gus /Gus/working #706/#708): the point of the
// heatmap is to see WHICH AGENTS are busier, not which day — so a day's tint is
// its raw message count, comparable across bots (a 1-msg day is always pale, a
// 50-msg day always darkest). A relative-to-own-max scale (the old #628 version)
// defeated this: every bot's peak went darkest, so all bots looked equally busy
// and sparse data collapsed to a single peak cell.
function bucketFor(total: number): number {
  if (total <= 0) return 0
  if (total <= 3) return 1 // 1–3
  if (total <= 9) return 2 // 4–9
  if (total <= 24) return 3 // 10–24
  return 4 // 25+
}

function dayLabel(dayKey: string): string {
  const d = new Date(`${dayKey}T00:00:00`)
  return Number.isNaN(d.getTime()) ? dayKey : DATE_FMT.format(d)
}

// Tooltip text for a slot. Active days split the two counts; empty days (a gap
// or a quiet day) still get a tooltip so hovering anywhere reads as responsive
// (Gus /Gus/working #695 — native `title` gave no feedback on empty cells).
function tooltipFor(dayKey: string, day: BotActivityDay | undefined): string {
  const label = dayLabel(dayKey)
  if (!day || day.handledCount + day.sentCount === 0) return `${label} · no activity`
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
    // Key by calendar day (stable across renders), not grid index. Every slot
    // gets a tooltip (active or empty) so hover always responds.
    return axisKeys.map((key) => {
      const d = byDay.get(key)
      return {
        key,
        bucket: d ? bucketFor(d.handledCount + d.sentCount) : 0,
        title: tooltipFor(key, d),
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
  //   • mobile: FULL-WIDTH horizontal ribbon — 2 rows × 15 columns (Gus #699:
  //     was 3 rows; 2 divides 30, a slimmer ribbon). 15 1fr columns span the
  //     card, cells auto-size square to the column width, left/right flush. The
  //     card places this as its own full-width row (not inside the meta column),
  //     so it truly spans the whole card.
  //   • desktop: a thin strip in the card's empty right side (#155/#165) —
  //     3 rows → 10 columns (Gus #695), size-3 cells. Only shown on wide
  //     screens (the card hides it before it can squeeze the meta text, #699).
  const isMobile = variant === "mobile"
  return (
    <div
      role="img"
      aria-label={`Activity over the last ${WINDOW_DAYS} days: ${total} messages total`}
      className={[
        "grid grid-flow-col gap-[3px]",
        isMobile
          ? "w-full [grid-template-columns:repeat(15,minmax(0,1fr))] [grid-template-rows:repeat(2,auto)]"
          : "w-fit [grid-template-rows:repeat(3,minmax(0,1fr))]",
        className ?? "",
      ].join(" ")}
    >
      {cells.map((c) => (
        // A real Tooltip (not native `title`) so hover is instant, styled, and
        // fires on every cell including empty days (Gus #695 — `title` was
        // OS-delayed and absent on empty cells, reading as "no reaction").
        <Tooltip key={c.key}>
          <TooltipTrigger
            render={
              <span
                className={[
                  "rounded-[2px]",
                  isMobile ? "aspect-square w-full" : "size-3",
                  BUCKET_CLASSES[c.bucket],
                ].join(" ")}
              />
            }
          />
          <TooltipContent>{c.title}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  )
}
