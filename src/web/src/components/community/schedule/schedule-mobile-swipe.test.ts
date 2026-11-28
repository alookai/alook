import { describe, expect, it } from "vitest"
import {
  advanceScheduleDaySwipe,
  beginScheduleDaySwipe,
  finishScheduleDaySwipe,
} from "./schedule-mobile-swipe"

describe("schedule-mobile-swipe", () => {
  it("ignores touch starts inside the left and right system edge zones", () => {
    expect(beginScheduleDaySwipe(12, 200, 390, 390, 100)).toBeNull()
    expect(beginScheduleDaySwipe(24, 200, 390, 390, 100)).toBeNull()
    expect(beginScheduleDaySwipe(366, 200, 390, 390, 100)).toBeNull()
    expect(beginScheduleDaySwipe(380, 200, 390, 390, 100)).toBeNull()
    expect(beginScheduleDaySwipe(120, 200, 390, 390, 100)).not.toBeNull()
  })

  it("rejects vertical scroll gestures and locks horizontal swipes cleanly", () => {
    const start = beginScheduleDaySwipe(200, 200, 390, 390, 100)!
    const vertical = advanceScheduleDaySwipe(start, 204, 218)
    expect(vertical.intent).toBe("rejected")
    expect(vertical.offsetX).toBe(0)
    expect(finishScheduleDaySwipe(vertical, 100, 200)).toBe(0)

    const horizontal = advanceScheduleDaySwipe(start, 180, 204)
    expect(horizontal.intent).toBe("horizontal")
    expect(horizontal.offsetX).toBe(-20)
  })

  it("commits next day on swipe left and previous day on swipe right past distance threshold", () => {
    const start = beginScheduleDaySwipe(200, 200, 390, 390, 100)!
    const dragLeft = advanceScheduleDaySwipe(start, 110, 202)
    expect(finishScheduleDaySwipe(dragLeft, 110, 500)).toBe(1)

    const dragRight = advanceScheduleDaySwipe(start, 290, 202)
    expect(finishScheduleDaySwipe(dragRight, 290, 500)).toBe(-1)
  })

  it("commits on a fast flick and cancels short slow drags", () => {
    const start = beginScheduleDaySwipe(200, 200, 390, 390, 100)!
    const flick = advanceScheduleDaySwipe(start, 160, 201)
    expect(finishScheduleDaySwipe(flick, 160, 170)).toBe(1)

    const slowShort = advanceScheduleDaySwipe(start, 165, 201)
    expect(finishScheduleDaySwipe(slowShort, 165, 600)).toBe(0)
  })
})
