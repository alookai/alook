"use client"

import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from "react"
import { useAtom, useCreateAtom, useCreateStore } from "@tanstack/react-store"

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
  const [element, setElement] = useAtom(useCreateAtom<HTMLDivElement | null>(null))
  const [root, setRoot] = useAtom(useCreateAtom<HTMLElement | null>(null))
  const consumeActiveGesturesRef = useRef<() => void>(() => {})
  const protocol = useCreateStore({ inputs: { onBeforeLoad, onLoad, hasMore, isFetching, isSettling }, intersecting: false, intersectionDemanded: false, loadLocked: false, fetchObserved: false })
  const sentinelRef = useCallback((node: HTMLDivElement | null) => { setElement(node) }, [setElement])

  useLayoutEffect(() => {
    setRoot(scrollRef.current)
    protocol.setState((state) => ({ ...state, inputs: { onBeforeLoad, onLoad, hasMore, isFetching, isSettling } }))
    const state = protocol.get()
    if (!hasMore) {
      protocol.setState((state) => ({ ...state, loadLocked: false, fetchObserved: false, intersectionDemanded: false }))
    } else if (isFetching && !state.fetchObserved) {
      protocol.setState((state) => ({ ...state, fetchObserved: true }))
    } else if (state.loadLocked && state.fetchObserved && !isFetching && !isSettling) {
      protocol.setState((state) => ({ ...state, loadLocked: false, fetchObserved: false }))
    }
  })

  const nearEdge = useCallback(() => !!root && (edge === "start"
    ? root.scrollTop <= 200
    : root.scrollHeight - root.clientHeight - root.scrollTop <= 200), [edge, root])
  const requestPage = useCallback((requireNearEdge: boolean) => {
    const state = protocol.get()
    if (state.loadLocked || !state.intersecting || (requireNearEdge && !nearEdge())
      || !state.inputs.onLoad || !state.inputs.hasMore || state.inputs.isFetching || state.inputs.isSettling) return
    protocol.setState((state) => ({ ...state, loadLocked: true, fetchObserved: false }))
    consumeActiveGesturesRef.current()
    state.inputs.onBeforeLoad?.()
    state.inputs.onLoad()
  }, [nearEdge, protocol])

  useEffect(() => {
    if (!root) return
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
    consumeActiveGesturesRef.current = () => {
      if (touchY !== null) touchDemanded = true
      if (wheelGestureActive) wheelDemanded = true
    }
    const onScroll = () => {
      if (!nearEdge()) protocol.setState((state) => ({ ...state, intersectionDemanded: false }))
    }
    const onWheel = (event: WheelEvent) => {
      if (!wheelGestureActive) { wheelGestureActive = true; wheelDemanded = false }
      if (wheelIdleTimer !== undefined) clearTimeout(wheelIdleTimer)
      wheelIdleTimer = setTimeout(finishWheelGesture, WHEEL_GESTURE_IDLE_MS)
      const towardEdge = (edge === "start" && event.deltaY < 0) || (edge === "end" && event.deltaY > 0)
      if (towardEdge && !wheelDemanded) { wheelDemanded = true; requestPage(true) }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      const active = root.ownerDocument.activeElement
      if (active && active !== root.ownerDocument.body && active !== root && !root.contains(active)) return
      const towardEdge = edge === "start"
        ? ["ArrowUp", "PageUp", "Home"].includes(event.key)
        : ["ArrowDown", "PageDown", "End"].includes(event.key)
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
      if (towardEdge && !touchDemanded) { touchDemanded = true; requestPage(true) }
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
    root.addEventListener("scroll", onScroll, { passive: true })
    root.addEventListener("wheel", onWheel, { passive: true })
    root.ownerDocument.addEventListener("keydown", onKeyDown)
    root.ownerDocument.addEventListener("keyup", onKeyUp)
    root.ownerDocument.defaultView?.addEventListener("blur", onWindowBlur)
    root.addEventListener("touchstart", onTouchStart, { passive: true })
    root.addEventListener("touchmove", onTouchMove, { passive: true })
    root.addEventListener("touchend", onTouchEnd, { passive: true })
    root.addEventListener("touchcancel", onTouchEnd, { passive: true })
    return () => {
      consumeActiveGesturesRef.current = () => {}
      protocol.setState((state) => ({ ...state, intersecting: false, intersectionDemanded: false }))
      if (wheelIdleTimer !== undefined) clearTimeout(wheelIdleTimer)
      root.removeEventListener("scroll", onScroll)
      root.removeEventListener("wheel", onWheel)
      root.ownerDocument.removeEventListener("keydown", onKeyDown)
      root.ownerDocument.removeEventListener("keyup", onKeyUp)
      root.ownerDocument.defaultView?.removeEventListener("blur", onWindowBlur)
      root.removeEventListener("touchstart", onTouchStart)
      root.removeEventListener("touchmove", onTouchMove)
      root.removeEventListener("touchend", onTouchEnd)
      root.removeEventListener("touchcancel", onTouchEnd)
    }
  }, [edge, nearEdge, protocol, requestPage, root])

  useEffect(() => {
    if (!element || !root || typeof IntersectionObserver === "undefined") return
    let active = true
    const observer = new IntersectionObserver((entries) => {
      if (!active || !root.contains(element)) return
      for (const entry of entries) {
        if (entry.target !== element) continue
        protocol.setState((state) => ({ ...state, intersecting: entry.isIntersecting }))
        if (!entry.isIntersecting) {
          protocol.setState((state) => ({ ...state, intersectionDemanded: false }))
        } else if (!protocol.get().intersectionDemanded) {
          protocol.setState((state) => ({ ...state, intersectionDemanded: true }))
          requestPage(false)
        }
      }
    }, { root, rootMargin: "200px" })
    observer.observe(element)
    return () => {
      active = false
      observer.disconnect()
      protocol.setState((state) => ({ ...state, intersecting: false }))
    }
  }, [element, protocol, requestPage, root])

  return sentinelRef
}
