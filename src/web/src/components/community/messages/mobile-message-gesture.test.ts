import { describe, expect, it } from "vitest"
import {
  MOBILE_REPLY_MAX_OFFSET_PX,
  advanceMobileReplyGesture,
  beginMobileReplyGesture,
  movedBeyondLongPressTolerance,
  shouldCommitMobileReply,
} from "./mobile-message-gesture"

describe("mobile message gesture", () => {
  it("guards the platform back edge", () => {
    expect(beginMobileReplyGesture(24, 20)).toBeNull()
    expect(beginMobileReplyGesture(25, 20)).not.toBeNull()
  })

  it("accepts only rightward horizontal intent and rejects vertical or leftward starts", () => {
    const start = beginMobileReplyGesture(80, 100)!
    expect(advanceMobileReplyGesture(start, 84, 104).gesture.intent).toBe("pending")
    expect(advanceMobileReplyGesture(start, 86, 120).gesture.intent).toBe("rejected")
    expect(advanceMobileReplyGesture(start, 60, 102).gesture.intent).toBe("rejected")
    expect(advanceMobileReplyGesture(start, 100, 104).gesture.intent).toBe("horizontal")
  })

  it("crosses once, clamps the visual offset, and commits the exact release", () => {
    const start = beginMobileReplyGesture(80, 100)!
    const crossed = advanceMobileReplyGesture(start, 146, 103)
    expect(crossed.gesture.thresholdCrossed).toBe(true)
    expect(crossed.fireHaptic).toBe(true)
    expect(shouldCommitMobileReply(crossed.gesture)).toBe(true)

    const farther = advanceMobileReplyGesture(crossed.gesture, 400, 103)
    expect(farther.gesture.offset).toBe(MOBILE_REPLY_MAX_OFFSET_PX)
    expect(farther.fireHaptic).toBe(false)
  })

  it("reversal below threshold cancels reply without a second haptic", () => {
    const start = beginMobileReplyGesture(80, 100)!
    const crossed = advanceMobileReplyGesture(start, 146, 101).gesture
    const reversed = advanceMobileReplyGesture(crossed, 110, 101)
    expect(reversed.gesture.thresholdCrossed).toBe(false)
    expect(reversed.gesture.hapticFired).toBe(true)
    expect(reversed.fireHaptic).toBe(false)
    expect(shouldCommitMobileReply(reversed.gesture)).toBe(false)
  })

  it("uses normal touch tolerance for avatar long press cancellation", () => {
    expect(movedBeyondLongPressTolerance(10, 10, 16, 17)).toBe(false)
    expect(movedBeyondLongPressTolerance(10, 10, 21, 10)).toBe(true)
  })
})
