"use client"

import { useCallback, useLayoutEffect, useRef } from "react"
import type React from "react"

export function shouldTranslateVerticalWheel({
  enabled,
  deltaX,
  deltaY,
  ctrlKey,
  shiftKey,
  scrollLeft,
  scrollWidth,
  clientWidth,
}: {
  enabled: boolean
  deltaX: number
  deltaY: number
  ctrlKey: boolean
  shiftKey: boolean
  scrollLeft: number
  scrollWidth: number
  clientWidth: number
}): boolean {
  if (!enabled || ctrlKey || shiftKey || deltaX !== 0 || deltaY === 0) return false
  const maxScrollLeft = Math.max(0, scrollWidth - clientWidth)
  return maxScrollLeft > 1 && (deltaY < 0 ? scrollLeft > 1 : scrollLeft < maxScrollLeft - 1)
}

export function useHorizontalOverflowRail<
  TScroller extends HTMLElement,
  TSelected extends HTMLElement,
>({
  contentKey,
  selectedKey,
  scrollStep = 48,
  preserveChildKeyboard = false,
  mapVerticalWheelToHorizontal = false,
}: {
  contentKey: string
  selectedKey: string | null
  scrollStep?: number
  preserveChildKeyboard?: boolean
  mapVerticalWheelToHorizontal?: boolean
}) {
  const scrollerRef = useRef<TScroller>(null)
  const selectedRef = useRef<TSelected>(null)
  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    const selected = selectedRef.current
    if (!scroller || !selected) return
    const reveal = () => {
      const scrollerRect = scroller.getBoundingClientRect()
      const selectedRect = selected.getBoundingClientRect()
      const style = getComputedStyle(scroller)
      const left = scrollerRect.left + (Number.parseFloat(style.scrollPaddingLeft) || 0)
      const right = scrollerRect.right - (Number.parseFloat(style.scrollPaddingRight) || 0)
      if (selectedRect.left < left) {
        scroller.scrollLeft -= left - selectedRect.left
      } else if (selectedRect.right > right) {
        scroller.scrollLeft += selectedRect.right - right
      }
    }
    reveal()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(reveal)
    observer.observe(scroller)
    observer.observe(selected)
    return () => observer.disconnect()
  }, [contentKey, selectedKey])

  const onKeyDown = useCallback((event: React.KeyboardEvent<TScroller>) => {
    const childOwnsKeyboard = preserveChildKeyboard && event.target !== event.currentTarget
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      if (!childOwnsKeyboard) event.preventDefault()
      event.currentTarget.scrollLeft += event.key === "ArrowLeft" ? -scrollStep : scrollStep
    } else if (event.key === "Home" || event.key === "End") {
      if (!childOwnsKeyboard) event.preventDefault()
      event.currentTarget.scrollLeft = event.key === "Home"
        ? 0
        : event.currentTarget.scrollWidth - event.currentTarget.clientWidth
    }
  }, [preserveChildKeyboard, scrollStep])

  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller || !mapVerticalWheelToHorizontal) return
    const onWheel = (event: WheelEvent) => {
      if (!shouldTranslateVerticalWheel({
        enabled: true,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        scrollLeft: scroller.scrollLeft,
        scrollWidth: scroller.scrollWidth,
        clientWidth: scroller.clientWidth,
      })) return
      event.preventDefault()
      scroller.scrollLeft += event.deltaY
    }
    scroller.addEventListener("wheel", onWheel, { passive: false })
    return () => scroller.removeEventListener("wheel", onWheel)
  }, [mapVerticalWheelToHorizontal])

  return { onKeyDown, scrollerRef, selectedRef }
}
