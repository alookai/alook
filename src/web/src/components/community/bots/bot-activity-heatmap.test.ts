import { describe, it, expect, vi, afterEach } from "vitest"
import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { utcDayKeyDaysAgo } from "@alook/shared"

// The real Tooltip pulls in floating-ui, which needs `window` — unavailable in
// this node renderer. Mock it to plain passthroughs: the trigger renders its
// `render` element (the cell span) and the content renders its text into a
// `data-tip` span, so we can still count cells and read each cell's tooltip.
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children?: React.ReactNode }) =>
    React.createElement(React.Fragment, {}, children),
  TooltipTrigger: ({ render }: { render: React.ReactElement }) => render,
  TooltipContent: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("span", { "data-tip": children }),
}))

import { BotActivityHeatmap, type BotActivityDay } from "./bot-activity-heatmap"

// The heatmap must place each sparse day at its true calendar slot (a gap of N
// days = N empty cells between them), NOT left-pad by count — Alli/Blair
// /Gus/working #666/#667. These tests pin that: cells are keyed by UTC day-key
// and filled from the sparse array by matching that key.

function render(days: BotActivityDay[]) {
  let r!: TestRenderer.ReactTestRenderer
  act(() => {
    r = TestRenderer.create(
      React.createElement(BotActivityHeatmap, { days, variant: "mobile" }),
    )
  })
  return r
}

// The cell spans in DOM order — the grid renders exactly 30, oldest→newest.
// (The mocked TooltipContent renders a `data-tip` span; exclude it here.)
function cells(r: TestRenderer.ReactTestRenderer) {
  return r.root.findAll(
    (n) => typeof n.type === "string" && n.type === "span" && n.props["data-tip"] === undefined,
  )
}

// Each cell's tooltip text, in DOM order — read from the mocked content spans.
function tips(r: TestRenderer.ReactTestRenderer): string[] {
  return r.root
    .findAll((n) => typeof n.type === "string" && n.type === "span" && n.props["data-tip"] !== undefined)
    .map((n) => String(n.props["data-tip"]))
}

afterEach(() => vi.useRealTimers())

describe("BotActivityHeatmap — calendar-axis fill", () => {
  it("always renders exactly 30 cells regardless of how sparse the data is", () => {
    expect(cells(render([])).length).toBe(30)
    expect(
      cells(render([{ day: utcDayKeyDaysAgo(new Date(), 0), handledCount: 3, sentCount: 1 }]))
        .length,
    ).toBe(30)
  })

  it("places two days 15 apart at their true slots, not adjacent", () => {
    const now = new Date()
    const older = utcDayKeyDaysAgo(now, 20) // 20 days ago
    const newer = utcDayKeyDaysAgo(now, 5) //  5 days ago
    const r = render([
      { day: older, handledCount: 4, sentCount: 0 },
      { day: newer, handledCount: 1, sentCount: 2 },
    ])
    const all = tips(r)
    // Oldest→newest over a 30-day axis (today-29 … today): index = 29 - daysAgo.
    const olderIdx = all.findIndex((t) => t.includes("4 handled"))
    const newerIdx = all.findIndex((t) => t.includes("1 handled"))
    expect(olderIdx).toBe(29 - 20)
    expect(newerIdx).toBe(29 - 5)
    // 15 calendar days apart → 15 index slots apart, not glued together.
    expect(newerIdx - olderIdx).toBe(15)
  })

  it("colors by ABSOLUTE per-day count (busier bots read darker), not relative to own max", () => {
    // Gus #706/#708: cross-bot comparability. A quiet bot (1/day) must NOT reach
    // the darkest bucket just because it's that bot's own peak. Bucket class is
    // on the trigger cell; find each active day's cell by DOM index and read its
    // bucket class. Thresholds: 1-2→b1, 3-5→b2, 6-10→b3, 11+→b4.
    const now = new Date()
    const r = render([
      { day: utcDayKeyDaysAgo(now, 3), handledCount: 1, sentCount: 0 }, // 1  → b1
      { day: utcDayKeyDaysAgo(now, 2), handledCount: 3, sentCount: 2 }, // 5  → b2
      { day: utcDayKeyDaysAgo(now, 1), handledCount: 6, sentCount: 0 }, // 6  → b3
      { day: utcDayKeyDaysAgo(now, 0), handledCount: 40, sentCount: 5 }, // 45 → b4
    ])
    // Split into tokens so "bg-status-online" (b4) doesn't match the /opacity
    // variants (b1–b3) as a substring.
    const tokens = cells(r).map((c) => String(c.props.className).split(/\s+/))
    const idx = (n: number) => 29 - n // oldest→newest slot for n days ago
    expect(tokens[idx(3)]).toContain("bg-status-online/30") // 1 msg — palest
    expect(tokens[idx(2)]).toContain("bg-status-online/55") // 5 msgs
    expect(tokens[idx(1)]).toContain("bg-status-online/80") // 6 msgs
    expect(tokens[idx(0)]).toContain("bg-status-online") // 45 msgs — darkest, no /opacity
    // the low-count day must NOT reach the darkest, even though it's this bot's min
    expect(tokens[idx(3)]).not.toContain("bg-status-online")
  })

  it("labels active days with the split and empty days as 'no activity'", () => {
    const r = render([{ day: utcDayKeyDaysAgo(new Date(), 10), handledCount: 2, sentCount: 0 }])
    const all = tips(r)
    // Every slot has a tooltip now (Gus #695 — hover must respond everywhere).
    expect(all.length).toBe(30)
    const active = all.filter((t) => t.includes("handled"))
    expect(active.length).toBe(1)
    expect(active[0]).toContain("2 handled · 0 sent")
    // The other 29 read as "no activity", not empty/undefined.
    expect(all.filter((t) => t.endsWith("no activity")).length).toBe(29)
  })
})
