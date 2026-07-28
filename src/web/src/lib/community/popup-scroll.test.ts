import { describe, it, expect } from "vitest"
import { nextListScrollTop } from "./popup-scroll"

// container viewport 100px tall, rows 40px each. scrollTop 0 shows rows 0..1
// and a sliver of row 2.
describe("nextListScrollTop", () => {
  it("scrolls up when the selected row is above the viewport", () => {
    // row 0 at top 0, currently scrolled down to 200
    expect(nextListScrollTop(200, 100, 0, 40)).toBe(0)
  })

  it("scrolls up to just above the row (minus margin) for a mid-list row above view", () => {
    // row at top 120, scrolled to 200 → bring top into view at 120-4
    expect(nextListScrollTop(200, 100, 120, 40)).toBe(116)
  })

  it("scrolls down so the row's bottom aligns to the viewport bottom", () => {
    // row 3 at top 120, height 40 → bottom 160; viewport 0..100 → scroll to
    // 160 - 100 + 4 = 64
    expect(nextListScrollTop(0, 100, 120, 40)).toBe(64)
  })

  it("leaves scrollTop unchanged when the row is already fully visible", () => {
    // row at top 40, height 40 → bottom 80, within viewport 0..100
    expect(nextListScrollTop(0, 100, 40, 40)).toBe(0)
  })

  it("never returns a negative scrollTop", () => {
    expect(nextListScrollTop(0, 100, 0, 40)).toBe(0)
  })
})
