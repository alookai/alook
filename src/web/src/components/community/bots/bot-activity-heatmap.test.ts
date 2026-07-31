import { describe, it, expect, vi, afterEach } from "vitest"
import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { utcDayKeyDaysAgo } from "@alook/shared"
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

// Every leaf cell in DOM order — the grid renders exactly 30, oldest→newest.
function cells(r: TestRenderer.ReactTestRenderer) {
  return r.root.findAll(
    (n) => typeof n.type === "string" && n.type === "span",
  )
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
    const all = cells(r)
    // Oldest→newest over a 30-day axis (today-29 … today): index = 29 - daysAgo.
    const olderIdx = all.findIndex((c) => c.props.title?.includes("4 handled"))
    const newerIdx = all.findIndex((c) => c.props.title?.includes("1 handled"))
    expect(olderIdx).toBe(29 - 20)
    expect(newerIdx).toBe(29 - 5)
    // 15 calendar days apart → 15 index slots apart, not glued together.
    expect(newerIdx - olderIdx).toBe(15)
  })

  it("gives empty days no tooltip (bucket-0 track cells)", () => {
    const r = render([{ day: utcDayKeyDaysAgo(new Date(), 10), handledCount: 2, sentCount: 0 }])
    const withTitle = cells(r).filter((c) => c.props.title)
    // Only the single active day carries a tooltip; the other 29 are empty.
    expect(withTitle.length).toBe(1)
    expect(withTitle[0].props.title).toContain("2 handled · 0 sent")
  })
})
