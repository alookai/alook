const SCHEDULE_SWIPE_EDGE_PX = 24
const SCHEDULE_SWIPE_INTENT_PX = 10
const SCHEDULE_SWIPE_DIRECTION_RATIO = 1.15
const SCHEDULE_SWIPE_COMMIT_MIN_PX = 44
const SCHEDULE_SWIPE_COMMIT_MAX_PX = 72
const SCHEDULE_SWIPE_COMMIT_RATIO = 0.2
const SCHEDULE_SWIPE_FLICK_MIN_PX = 28
const SCHEDULE_SWIPE_FLICK_VELOCITY_PX_PER_MS = 0.35

type ScheduleDaySwipeIntent = "pending" | "horizontal" | "rejected"
export type ScheduleDaySwipeStep = -1 | 0 | 1

export type ScheduleDaySwipeGesture = {
  startX: number
  startY: number
  startTime: number
  containerWidth: number
  intent: ScheduleDaySwipeIntent
  offsetX: number
}

export function beginScheduleDaySwipe(
  clientX: number,
  clientY: number,
  containerWidth: number,
  viewportWidth: number,
  timeStamp: number,
): ScheduleDaySwipeGesture | null {
  if (clientX <= SCHEDULE_SWIPE_EDGE_PX) return null
  if (viewportWidth > 0 && viewportWidth - clientX <= SCHEDULE_SWIPE_EDGE_PX) return null
  return {
    startX: clientX,
    startY: clientY,
    startTime: timeStamp,
    containerWidth: Math.max(1, containerWidth),
    intent: "pending",
    offsetX: 0,
  }
}

export function advanceScheduleDaySwipe(
  gesture: ScheduleDaySwipeGesture,
  clientX: number,
  clientY: number,
): ScheduleDaySwipeGesture {
  if (gesture.intent === "rejected") return gesture

  const dx = clientX - gesture.startX
  const dy = clientY - gesture.startY
  const absX = Math.abs(dx)
  const absY = Math.abs(dy)
  let intent: ScheduleDaySwipeIntent = gesture.intent

  if (intent === "pending" && Math.max(absX, absY) >= SCHEDULE_SWIPE_INTENT_PX) {
    intent = absX > absY * SCHEDULE_SWIPE_DIRECTION_RATIO ? "horizontal" : "rejected"
  }

  if (intent !== "horizontal") {
    return { ...gesture, intent, offsetX: 0 }
  }

  const maxOffset = gesture.containerWidth
  const offsetX = Math.max(-maxOffset, Math.min(maxOffset, dx))
  return { ...gesture, intent, offsetX }
}

export function finishScheduleDaySwipe(
  gesture: ScheduleDaySwipeGesture | null,
  clientX: number,
  timeStamp: number,
): ScheduleDaySwipeStep {
  if (!gesture || gesture.intent !== "horizontal") return 0

  const dx = clientX - gesture.startX
  const absX = Math.abs(dx)
  const dt = Math.max(1, timeStamp - gesture.startTime)
  const velocity = absX / dt
  const distanceThreshold = Math.min(
    SCHEDULE_SWIPE_COMMIT_MAX_PX,
    Math.max(SCHEDULE_SWIPE_COMMIT_MIN_PX, gesture.containerWidth * SCHEDULE_SWIPE_COMMIT_RATIO),
  )

  const committed = absX >= distanceThreshold
    || (absX >= SCHEDULE_SWIPE_FLICK_MIN_PX && velocity >= SCHEDULE_SWIPE_FLICK_VELOCITY_PX_PER_MS)
  if (!committed) return 0

  return dx < 0 ? 1 : -1
}
