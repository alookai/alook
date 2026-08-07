"use client"

import { useEffect, useRef, type RefObject } from "react"

export function useVirtualCursorSentinel({
  scrollRef,
  hasMore,
  isFetching,
  onLoad,
  edge,
}: {
  scrollRef: RefObject<HTMLElement | null>
  hasMore?: boolean
  isFetching?: boolean
  onLoad?: () => void
  edge: "start" | "end"
}) {
  const sentinelRef = useRef<HTMLDivElement>(null)
  const stateRef = useRef({ onLoad, hasMore, isFetching })
  const intersectingRef = useRef(false)
  const pendingDemandRef = useRef(false)
  const wasFetchingRef = useRef(isFetching)

  useEffect(() => { stateRef.current = { onLoad, hasMore, isFetching } })
  useEffect(() => {
    const wasFetching = wasFetchingRef.current
    wasFetchingRef.current = isFetching
    if (!hasMore) {
      pendingDemandRef.current = false
      intersectingRef.current = false
      return
    }
    if (wasFetching && !isFetching && pendingDemandRef.current && intersectingRef.current && onLoad) {
      pendingDemandRef.current = false
      onLoad()
    }
  }, [hasMore, isFetching, onLoad])

  useEffect(() => {
    const element = sentinelRef.current
    const root = scrollRef.current
    if (!element || !root) return
    const observer = new IntersectionObserver((entries) => {
      const state = stateRef.current
      for (const entry of entries) {
        intersectingRef.current = entry.isIntersecting
        if (!entry.isIntersecting || !state.onLoad || !state.hasMore) continue
        if (state.isFetching) pendingDemandRef.current = true
        else state.onLoad()
        break
      }
    }, { root, rootMargin: "200px" })
    let lastScrollTop = root.scrollTop
    const onScroll = () => {
      const next = root.scrollTop
      const movingTowardEdge = edge === "start" ? next < lastScrollTop : next > lastScrollTop
      lastScrollTop = next
      const nearEdge = edge === "start"
        ? next <= 200
        : root.scrollHeight - root.clientHeight - next <= 200
      const state = stateRef.current
      if (movingTowardEdge && nearEdge && intersectingRef.current && state.hasMore && state.isFetching) {
        pendingDemandRef.current = true
      }
    }
    observer.observe(element)
    root.addEventListener("scroll", onScroll, { passive: true })
    return () => {
      pendingDemandRef.current = false
      intersectingRef.current = false
      root.removeEventListener("scroll", onScroll)
      observer.disconnect()
    }
  }, [edge, hasMore, scrollRef])

  return sentinelRef
}
