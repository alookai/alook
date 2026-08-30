"use client"

import { useCallback, useLayoutEffect, useRef, useState } from "react"
import type React from "react"

export type HorizontalOverflowFades = { left: boolean; right: boolean }

export function horizontalOverflowFades({
  scrollLeft,
  scrollWidth,
  clientWidth,
}: {
  scrollLeft: number
  scrollWidth: number
  clientWidth: number
}): HorizontalOverflowFades {
  const maxScrollLeft = Math.max(0, scrollWidth - clientWidth)
  if (maxScrollLeft <= 1) return { left: false, right: false }
  return {
    left: scrollLeft > 1,
    right: scrollLeft < maxScrollLeft - 1,
  }
}

export function useHorizontalOverflowRail<
  TScroller extends HTMLElement,
  TSelected extends HTMLElement,
>({
  contentKey,
  selectedKey,
  scrollStep = 48,
  preserveChildKeyboard = false,
}: {
  contentKey: string
  selectedKey: string | null
  scrollStep?: number
  preserveChildKeyboard?: boolean
}) {
  const scrollerRef = useRef<TScroller>(null)
  const selectedRef = useRef<TSelected>(null)
  const [fades, setFades] = useState<HorizontalOverflowFades>({ left: false, right: false })

  const syncFades = useCallback(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    const next = horizontalOverflowFades(scroller)
    setFades((current) => current.left === next.left && current.right === next.right ? current : next)
  }, [])

  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    const selected = selectedRef.current
    if (!scroller || !selected) return
    const scrollerRect = scroller.getBoundingClientRect()
    const selectedRect = selected.getBoundingClientRect()
    if (selectedRect.left < scrollerRect.left) {
      scroller.scrollLeft -= scrollerRect.left - selectedRect.left
    } else if (selectedRect.right > scrollerRect.right) {
      scroller.scrollLeft += selectedRect.right - scrollerRect.right
    }
    syncFades()
  }, [contentKey, selectedKey, syncFades])

  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    syncFades()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(syncFades)
    observer.observe(scroller)
    return () => observer.disconnect()
  }, [contentKey, syncFades])

  const onKeyDown = useCallback((event: React.KeyboardEvent<TScroller>) => {
    const childOwnsKeyboard = preserveChildKeyboard && event.target !== event.currentTarget
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      if (!childOwnsKeyboard) event.preventDefault()
      event.currentTarget.scrollLeft += event.key === "ArrowLeft" ? -scrollStep : scrollStep
      syncFades()
    } else if (event.key === "Home" || event.key === "End") {
      if (!childOwnsKeyboard) event.preventDefault()
      event.currentTarget.scrollLeft = event.key === "Home"
        ? 0
        : event.currentTarget.scrollWidth - event.currentTarget.clientWidth
      syncFades()
    }
  }, [preserveChildKeyboard, scrollStep, syncFades])

  return { fades, onKeyDown, onScroll: syncFades, scrollerRef, selectedRef }
}

export function HorizontalOverflowFadeOverlays({
  fades,
  leftTestId,
  rightTestId,
  surface = "background",
}: {
  fades: HorizontalOverflowFades
  leftTestId?: string
  rightTestId?: string
  surface?: "background" | "popover"
}) {
  const fromSurface = surface === "popover" ? "from-popover" : "from-background"
  return (
    <>
      {fades.left && (
        <span
          aria-hidden
          data-testid={leftTestId}
          className={`pointer-events-none absolute inset-y-0 left-0 z-10 w-3.5 bg-linear-to-r to-transparent ${fromSurface}`}
        />
      )}
      {fades.right && (
        <span
          aria-hidden
          data-testid={rightTestId}
          className={`pointer-events-none absolute inset-y-0 right-0 z-10 w-3.5 bg-linear-to-l to-transparent ${fromSurface}`}
        />
      )}
    </>
  )
}
