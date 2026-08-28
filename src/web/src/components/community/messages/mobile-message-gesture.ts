const MOBILE_REPLY_EDGE_GUARD_PX = 24
const MOBILE_REPLY_INTENT_PX = 8
const MOBILE_REPLY_THRESHOLD_PX = 64
export const MOBILE_REPLY_MAX_OFFSET_PX = 88
const MOBILE_LONG_PRESS_TOLERANCE_PX = 10

export type MobileReplyGesture = {
  startX: number
  startY: number
  offset: number
  intent: "pending" | "horizontal" | "rejected"
  thresholdCrossed: boolean
  hapticFired: boolean
}

export function beginMobileReplyGesture(
  clientX: number,
  clientY: number,
): MobileReplyGesture | null {
  if (clientX <= MOBILE_REPLY_EDGE_GUARD_PX) return null
  return {
    startX: clientX,
    startY: clientY,
    offset: 0,
    intent: "pending",
    thresholdCrossed: false,
    hapticFired: false,
  }
}

export function advanceMobileReplyGesture(
  gesture: MobileReplyGesture,
  clientX: number,
  clientY: number,
): { gesture: MobileReplyGesture; fireHaptic: boolean } {
  if (gesture.intent === "rejected") return { gesture, fireHaptic: false }

  const dx = clientX - gesture.startX
  const dy = clientY - gesture.startY
  const absX = Math.abs(dx)
  const absY = Math.abs(dy)
  let intent: MobileReplyGesture["intent"] = gesture.intent

  if (intent === "pending" && Math.max(absX, absY) >= MOBILE_REPLY_INTENT_PX) {
    intent = dx > 0 && absX > absY ? "horizontal" : "rejected"
  }
  if (intent !== "horizontal") {
    return {
      gesture: { ...gesture, intent, offset: 0, thresholdCrossed: false },
      fireHaptic: false,
    }
  }

  const offset = Math.min(MOBILE_REPLY_MAX_OFFSET_PX, Math.max(0, dx))
  const thresholdCrossed = offset >= MOBILE_REPLY_THRESHOLD_PX
  const fireHaptic = thresholdCrossed && !gesture.hapticFired
  return {
    gesture: {
      ...gesture,
      intent,
      offset,
      thresholdCrossed,
      hapticFired: gesture.hapticFired || fireHaptic,
    },
    fireHaptic,
  }
}

export function shouldCommitMobileReply(gesture: MobileReplyGesture | null): boolean {
  return gesture?.intent === "horizontal" && gesture.thresholdCrossed
}

export function movedBeyondLongPressTolerance(
  startX: number,
  startY: number,
  clientX: number,
  clientY: number,
): boolean {
  return Math.hypot(clientX - startX, clientY - startY) > MOBILE_LONG_PRESS_TOLERANCE_PX
}
