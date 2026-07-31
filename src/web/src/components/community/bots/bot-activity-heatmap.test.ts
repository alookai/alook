import { describe, it, expect, vi, afterEach } from "vitest"
import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { utcDayKeyDaysAgo } from "@alook/shared"

// The real Tooltip pulls in floating-ui, which needs `window` — unavailable in
// this node renderer. Mock it: the trigger renders its `render` element (the
// cell) tagged with data-cell; the content wraps its children under a data-tip
// marker so we can find each and read its (possibly multi-line) text.
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children?: React.ReactNode }) =>
    React.createElement(React.Fragment, {}, children),
  TooltipTrigger: ({ render }: { render: React.ReactElement }) =>
    React.cloneElement(render, { "data-cell": true }),
  TooltipContent: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", { "data-tip": true }, children),
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
      React.createElement(BotActivityHeatmap, { days }),
    )
  })
  return r
}

// The cell spans in DOM order — the grid renders exactly 30, oldest→newest.
function cells(r: TestRenderer.ReactTestRenderer) {
  return r.root.findAll((n) => n.props?.["data-cell"] === true)
}

// Flatten a node's text content (joins the multi-line tooltip spans).
function textOf(node: TestRenderer.ReactTestInstance): string {
  return node
    .findAll((n) => typeof n.children?.[0] === "string")
    .map((n) => n.children.filter((c): c is string => typeof c === "string").join(""))
    .join(" ")
}

// Each cell's tooltip text, in DOM order — joined across its lines.
function tips(r: TestRenderer.ReactTestRenderer): string[] {
  return r.root.findAll((n) => n.props?.["data-tip"] === true).map(textOf)
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
    const olderIdx = all.findIndex((t) => t.includes("4 messages handled"))
    const newerIdx = all.findIndex((t) => t.includes("1 message handled")) // singular
    expect(olderIdx).toBe(29 - 20)
    expect(newerIdx).toBe(29 - 5)
    // 15 calendar days apart → 15 index slots apart, not glued together.
    expect(newerIdx - olderIdx).toBe(15)
  })

  it("colors by ABSOLUTE SENT count per day (busier bots read darker), across fixed bands", () => {
    // Gus /Gus/general #47: color tracks the day's SENT count only, absolute
    // bands 0 / 1-10 / 11-30 / 31-50 / 51+ (comparable across bots). Bucket class
    // is on the trigger cell; find each day's cell by DOM index.
    const now = new Date()
    const r = render([
      { day: utcDayKeyDaysAgo(now, 3), handledCount: 99, sentCount: 5 }, // sent 5  → b1
      { day: utcDayKeyDaysAgo(now, 2), handledCount: 0, sentCount: 20 }, // sent 20 → b2
      { day: utcDayKeyDaysAgo(now, 1), handledCount: 0, sentCount: 45 }, // sent 45 → b3
      { day: utcDayKeyDaysAgo(now, 0), handledCount: 0, sentCount: 80 }, // sent 80 → b4
    ])
    // Split into tokens so "bg-status-online" (b4) doesn't match the /opacity
    // variants (b1–b3) as a substring.
    const tokens = cells(r).map((c) => String(c.props.className).split(/\s+/))
    const idx = (n: number) => 29 - n // oldest→newest slot for n days ago
    expect(tokens[idx(3)]).toContain("bg-status-online/30") // sent 5 — palest
    expect(tokens[idx(2)]).toContain("bg-status-online/55") // sent 20
    expect(tokens[idx(1)]).toContain("bg-status-online/80") // sent 45
    expect(tokens[idx(0)]).toContain("bg-status-online") // sent 80 — darkest, no /opacity
    // a high HANDLED but low SENT day must NOT read dark (handled doesn't color)
    expect(tokens[idx(3)]).not.toContain("bg-status-online")
  })

  it("colors by sent, not handled — a handled-heavy / sent-light day stays pale", () => {
    const now = new Date()
    // 200 handled but only 3 sent → sent band b1 (pale), NOT dark. Tooltip still
    // shows both numbers (Blair /Gus/general #48 — color=sent, tooltip=both).
    const r = render([{ day: utcDayKeyDaysAgo(now, 0), handledCount: 200, sentCount: 3 }])
    const cell = cells(r)[29] // today = last slot
    expect(String(cell.props.className).split(/\s+/)).toContain("bg-status-online/30") // b1 by sent=3
    const tip = tips(r).find((t) => t.includes("handled"))
    expect(tip).toContain("200 messages handled")
    expect(tip).toContain("3 messages sent")
  })

  it("labels active days with full sentences and empty days as 'No activity'", () => {
    const r = render([{ day: utcDayKeyDaysAgo(new Date(), 10), handledCount: 2, sentCount: 0 }])
    const all = tips(r)
    // Every slot has a tooltip now (Gus #695 — hover must respond everywhere).
    expect(all.length).toBe(30)
    const active = all.filter((t) => t.includes("handled"))
    expect(active.length).toBe(1)
    // Full sentences, pluralized (Gus #732 / Alli #735): 2 messages, 0 messages.
    expect(active[0]).toContain("2 messages handled")
    expect(active[0]).toContain("0 messages sent")
    // The other 29 read as "No activity".
    expect(all.filter((t) => t.includes("No activity")).length).toBe(29)
  })

  it("pluralizes the tooltip counts (1 message vs N messages)", () => {
    const r = render([{ day: utcDayKeyDaysAgo(new Date(), 0), handledCount: 1, sentCount: 3 }])
    const tip = tips(r).find((t) => t.includes("handled"))!
    expect(tip).toContain("1 message handled") // singular
    expect(tip).toContain("3 messages sent") // plural
  })
})
