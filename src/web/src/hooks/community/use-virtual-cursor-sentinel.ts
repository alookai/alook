"use client"

import { useEffect, useRef, type RefObject } from "react"

// Wheel events have no lifecycle boundary. A short quiet window separates one
// trackpad/mouse-wheel burst (including momentum) from the next user gesture.
const WHEEL_GESTURE_IDLE_MS = 180

export function useVirtualCursorSentinel({
  scrollRef,
  hasMore,
  isFetching,
  isSettling,
  onBeforeLoad,
  onLoad,
  edge,
}: {
  scrollRef: RefObject<HTMLElement | null>
  hasMore?: boolean
  isFetching?: boolean
  isSettling?: boolean
  onBeforeLoad?: () => void
  onLoad?: () => void
  edge: "start" | "end"
}) {
  const sentinelRef = useRef<HTMLDivElement>(null)
  const stateRef = useRef({ onBeforeLoad, onLoad, hasMore, isFetching, isSettling })
  const intersectingRef = useRef(false)
  const intersectionDemandedRef = useRef(false)
  const loadLockedRef = useRef(false)
  const fetchObservedRef = useRef(false)

  useEffect(() => {
    stateRef.current = { onBeforeLoad, onLoad, hasMore, isFetching, isSettling }
    if (!hasMore) {
      loadLockedRef.current = false
      fetchObservedRef.current = false
      intersectionDemandedRef.current = false
      return
    }
    if (isFetching) fetchObservedRef.current = true
    if (
      loadLockedRef.current
      && fetchObservedRef.current
      && !isFetching
      && !isSettling
    ) {
      loadLockedRef.current = false
      fetchObservedRef.current = false
    }
  })

  useEffect(() => {
    const element = sentinelRef.current
    const root = scrollRef.current
    if (!element || !root) return

    let touchY: number | null = null
    let touchDemanded = false
    let wheelGestureActive = false
    let wheelDemanded = false
    let wheelIdleTimer: ReturnType<typeof setTimeout> | undefined
    const heldKeys = new Set<string>()

    const finishWheelGesture = () => {
      wheelGestureActive = false
      wheelDemanded = false
      wheelIdleTimer = undefined
    }
    const consumeActiveGestures = () => {
      if (touchY !== null) touchDemanded = true
      if (wheelGestureActive) wheelDemanded = true
    }
    const nearEdge = () => edge === "start"
      ? root.scrollTop <= 200
      : root.scrollHeight - root.clientHeight - root.scrollTop <= 200
    const requestPage = (requireNearEdge: boolean) => {
      const state = stateRef.current
      if (
        loadLockedRef.current
        || !intersectingRef.current
        || (requireNearEdge && !nearEdge())
        || !state.onLoad
        || !state.hasMore
        || state.isFetching
        || state.isSettling
      ) return
      loadLockedRef.current = true
      fetchObservedRef.current = false
      consumeActiveGestures()
      state.onBeforeLoad?.()
      state.onLoad()
    }
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        intersectingRef.current = entry.isIntersecting
        if (!entry.isIntersecting) {
          intersectionDemandedRef.current = false
          continue
        }
        if (!intersectionDemandedRef.current) {
          intersectionDemandedRef.current = true
          requestPage(false)
        }
        break
      }
    }, { root, rootMargin: "200px" })
    const onWheel = (event: WheelEvent) => {
      if (!wheelGestureActive) {
        wheelGestureActive = true
        wheelDemanded = false
      }
      if (wheelIdleTimer !== undefined) clearTimeout(wheelIdleTimer)
      wheelIdleTimer = setTimeout(finishWheelGesture, WHEEL_GESTURE_IDLE_MS)
      const towardEdge = (edge === "start" && event.deltaY < 0)
        || (edge === "end" && event.deltaY > 0)
      if (towardEdge && !wheelDemanded) {
        wheelDemanded = true
        requestPage(true)
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      const active = root.ownerDocument.activeElement
      if (
        active
        && active !== root.ownerDocument.body
        && active !== root
        && !root.contains(active)
      ) return
      const towardStart = ["ArrowUp", "PageUp", "Home"].includes(event.key)
      const towardEnd = ["ArrowDown", "PageDown", "End"].includes(event.key)
      const towardEdge = (edge === "start" && towardStart) || (edge === "end" && towardEnd)
      if (!towardEdge || event.repeat || heldKeys.has(event.key)) return
      heldKeys.add(event.key)
      requestPage(true)
    }
    const onKeyUp = (event: KeyboardEvent) => { heldKeys.delete(event.key) }
    const onTouchStart = (event: TouchEvent) => {
      if (touchY === null) touchDemanded = false
      touchY = event.touches[0]?.clientY ?? null
    }
    const onTouchMove = (event: TouchEvent) => {
      const nextY = event.touches[0]?.clientY ?? null
      if (touchY === null || nextY === null) return
      const delta = nextY - touchY
      touchY = nextY
      const towardEdge = (edge === "start" && delta > 0) || (edge === "end" && delta < 0)
      if (towardEdge && !touchDemanded) {
        touchDemanded = true
        requestPage(true)
      }
    }
    const onTouchEnd = (event: TouchEvent) => {
      touchY = event.touches[0]?.clientY ?? null
      if (touchY === null) touchDemanded = false
    }
    const onWindowBlur = () => {
      heldKeys.clear()
      touchY = null
      touchDemanded = false
      if (wheelIdleTimer !== undefined) clearTimeout(wheelIdleTimer)
      finishWheelGesture()
    }

    observer.observe(element)
    root.addEventListener("wheel", onWheel, { passive: true })
    root.ownerDocument.addEventListener("keydown", onKeyDown)
    root.ownerDocument.addEventListener("keyup", onKeyUp)
    root.ownerDocument.defaultView?.addEventListener("blur", onWindowBlur)
    root.addEventListener("touchstart", onTouchStart, { passive: true })
    root.addEventListener("touchmove", onTouchMove, { passive: true })
    root.addEventListener("touchend", onTouchEnd, { passive: true })
    root.addEventListener("touchcancel", onTouchEnd, { passive: true })
    return () => {
      intersectingRef.current = false
      intersectionDemandedRef.current = false
      if (wheelIdleTimer !== undefined) clearTimeout(wheelIdleTimer)
      root.removeEventListener("wheel", onWheel)
      root.ownerDocument.removeEventListener("keydown", onKeyDown)
      root.ownerDocument.removeEventListener("keyup", onKeyUp)
      root.ownerDocument.defaultView?.removeEventListener("blur", onWindowBlur)
      root.removeEventListener("touchstart", onTouchStart)
      root.removeEventListener("touchmove", onTouchMove)
      root.removeEventListener("touchend", onTouchEnd)
      root.removeEventListener("touchcancel", onTouchEnd)
      observer.disconnect()
    }
  }, [edge, hasMore, scrollRef])

  return sentinelRef
}
