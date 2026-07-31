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

// ABSOLUTE thresholds (Gus /Gus/working #708/#714): the heatmap is for seeing
// WHICH AGENTS are busier, not which day — so tint maps a day's weighted score
// to a fixed band, comparable across bots (a relative-to-own-max scale, the old
// #628 version, made every bot's peak darkest so all looked equally busy). Bands
// are sized for the steady-state ~100 msgs/day an agent handles (Gus #714), not
// today's dev-period cross-wake noise. `score` is the weighted value below, NOT
// the raw message count.
function bucketFor(score: number): number {
  if (score <= 0) return 0
  if (score <= 50) return 1 // 1–50
  if (score <= 100) return 2 // 51–100
  if (score <= 500) return 3 // 101–500
  return 4 // 500+
}

function dayLabel(dayKey: string): string {
  const d = new Date(`${dayKey}T00:00:00`)
  return Number.isNaN(d.getTime()) ? dayKey : DATE_FMT.format(d)
}

function messages(n: number): string {
  return `${n} ${n === 1 ? "message" : "messages"}`
}

// Tooltip content for a slot: the date, then a full sentence per counter (Gus
// /Gus/working #732, Alli #735 — "N messages handled" / "N messages sent",
// pluralized). Empty days (a gap or a quiet day) still get a tooltip so hovering
// anywhere reads as responsive (Gus #695), collapsed to one "No activity" line.
function tooltipFor(dayKey: string, day: BotActivityDay | undefined): string[] {
  const label = dayLabel(dayKey)
  if (!day || day.handledCount + day.sentCount === 0) return [label, "No activity"]
  return [label, `${messages(day.handledCount)} handled`, `${messages(day.sentCount)} sent`]
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
// ONE fixed-size layout everywhere (Gus /Gus/working #720): a 3-row × 10-col
// strip of small fixed cells. Cell size never changes, so moving the strip
// between the card's right side (wide) and its own row below (narrow) has no
// size jump. `className` lets the card apply layout/visibility wrappers.
export function BotActivityHeatmap({
  days,
  className,
}: {
  days: BotActivityDay[]
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
        // Coloring weight (Gus #716): sent counts double — sending a message is
        // impact/real work, vs just being woken to handle one. This weight feeds
        // ONLY the color bucket; the tooltip and the stored counts stay raw
        // (Blair #717 — never let the weight leak into what we display or store).
        bucket: d ? bucketFor(d.handledCount + d.sentCount * 2) : 0,
        title: tooltipFor(key, d),
      }
    })
  }, [days])

  const total = useMemo(
    () => days.reduce((s, d) => s + d.handledCount + d.sentCount, 0),
    [days],
  )

  // ONE layout everywhere (Gus #720): cells flow column-by-column
  // (grid-flow-col), 3 rows → 10 columns (3 divides 30 → flush). Fixed-size
  // cells (size-3), so cell size is CONSTANT no matter where the card places the
  // strip (right side when wide, own row below when narrow) — no size jump, and
  // it stays compact so it only needs to wrap when space actually runs out.
  return (
    <div
      role="img"
      aria-label={`Activity over the last ${WINDOW_DAYS} days: ${total} messages total`}
      className={[
        "grid w-fit grid-flow-col gap-[3px] [grid-template-rows:repeat(3,minmax(0,1fr))]",
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
                className={["size-3 rounded-[2px]", BUCKET_CLASSES[c.bucket]].join(" ")}
              />
            }
          />
          <TooltipContent>
            <span className="flex flex-col gap-0.5">
              {c.title.map((line, i) => (
                <span key={i} className={i === 0 ? "font-medium" : ""}>
                  {line}
                </span>
              ))}
            </span>
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  )
}
