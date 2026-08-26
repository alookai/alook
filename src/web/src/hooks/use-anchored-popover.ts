"use client"

import { useEffect, useState, type CSSProperties } from "react"

export interface AnchorRect {
  top: number
  bottom: number
  left: number
  right: number
}

export type AnchorRectResolver = () => AnchorRect | null

export interface VisualViewportRect {
  top: number
  left: number
  width: number
  height: number
}

export interface AnchoredPopoverGeometry {
  rect: AnchorRect
  viewport: VisualViewportRect
}

type AnchoredPopoverStyle = CSSProperties & {
  "--anchored-popover-max-height": string
}

const VIEWPORT_MARGIN = 8
const POPOVER_GAP = 4
const POPOVER_CHROME_HEIGHT = 10
const MIN_LIST_HEIGHT = 48
const SETTLE_REFRESH_MS = 200

export function readVisualViewport(): VisualViewportRect | null {
  if (typeof window === "undefined") return null
  const viewport = window.visualViewport
  return {
    top: viewport?.offsetTop ?? 0,
    left: viewport?.offsetLeft ?? 0,
    width: viewport?.width ?? window.innerWidth,
    height: viewport?.height ?? window.innerHeight,
  }
}

function readAnchoredPopoverGeometry(
  getRect: AnchorRectResolver,
): AnchoredPopoverGeometry | null {
  const rect = getRect()
  const viewport = readVisualViewport()
  return rect && viewport ? { rect, viewport } : null
}

function geometryEqual(
  a: AnchoredPopoverGeometry | null,
  b: AnchoredPopoverGeometry | null,
): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.rect.top === b.rect.top
    && a.rect.bottom === b.rect.bottom
    && a.rect.left === b.rect.left
    && a.rect.right === b.rect.right
    && a.viewport.top === b.viewport.top
    && a.viewport.left === b.viewport.left
    && a.viewport.width === b.viewport.width
    && a.viewport.height === b.viewport.height
}

/**
 * Subscribe to every layout signal that can move a viewport-fixed caret menu.
 * The trailing refresh is deliberate: `useKeyboardScroll` applies its iOS
 * fallback transform after a 150ms debounce, after the original
 * `visualViewport` event has already fired.
 */
export function subscribeAnchoredPopoverChanges(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {}

  let frame: number | null = null
  let settleTimer: ReturnType<typeof setTimeout> | null = null

  const scheduleFrame = () => {
    if (frame !== null) return
    frame = window.requestAnimationFrame(() => {
      frame = null
      onChange()
    })
  }
  const handleViewportChange = () => {
    scheduleFrame()
    if (settleTimer !== null) clearTimeout(settleTimer)
    settleTimer = setTimeout(scheduleFrame, SETTLE_REFRESH_MS)
  }

  window.addEventListener("resize", handleViewportChange)
  window.addEventListener("scroll", handleViewportChange, true)
  window.visualViewport?.addEventListener("resize", handleViewportChange)
  window.visualViewport?.addEventListener("scroll", handleViewportChange)

  return () => {
    window.removeEventListener("resize", handleViewportChange)
    window.removeEventListener("scroll", handleViewportChange, true)
    window.visualViewport?.removeEventListener("resize", handleViewportChange)
    window.visualViewport?.removeEventListener("scroll", handleViewportChange)
    if (frame !== null) window.cancelAnimationFrame(frame)
    if (settleTimer !== null) clearTimeout(settleTimer)
  }
}

/** Re-resolves a live caret/element rect whenever the visible viewport moves. */
export function useAnchoredPopover(
  getRect: AnchorRectResolver | null,
  active: boolean,
): AnchoredPopoverGeometry | null {
  const [snapshot, setSnapshot] = useState<{
    getRect: AnchorRectResolver
    geometry: AnchoredPopoverGeometry | null
  } | null>(null)

  useEffect(() => {
    if (!active || !getRect) return
    const refresh = () => {
      const next = readAnchoredPopoverGeometry(getRect)
      setSnapshot((current) => current?.getRect === getRect
        && geometryEqual(current.geometry, next)
        ? current
        : { getRect, geometry: next })
    }
    refresh()
    return subscribeAnchoredPopoverChanges(refresh)
  }, [active, getRect])

  return active && snapshot?.getRect === getRect ? snapshot.geometry : null
}

/**
 * Position a fixed popup inside the visual viewport. Above is preferred; when
 * neither side fits the full list, use the roomier side and shrink the list.
 */
export function anchoredPopoverStyle(
  rect: AnchorRect,
  viewport: VisualViewportRect,
  popupWidth: number,
  popupMaxHeight: number,
): AnchoredPopoverStyle {
  const viewportRight = viewport.left + viewport.width
  const viewportBottom = viewport.top + viewport.height
  const minVisibleLeft = viewport.left + VIEWPORT_MARGIN
  const maxVisibleLeft = Math.max(
    minVisibleLeft,
    viewportRight - popupWidth - VIEWPORT_MARGIN,
  )
  const left = Math.min(
    Math.max(rect.left, minVisibleLeft),
    maxVisibleLeft,
  )

  const spaceAbove = rect.top - viewport.top
  const spaceBelow = viewportBottom - rect.bottom
  const fullHeight = popupMaxHeight + POPOVER_CHROME_HEIGHT + POPOVER_GAP + VIEWPORT_MARGIN
  const placeBelow = spaceAbove < fullHeight
    && (spaceBelow >= fullHeight || spaceBelow > spaceAbove)
  const available = (placeBelow ? spaceBelow : spaceAbove)
    - POPOVER_GAP
    - VIEWPORT_MARGIN
    - POPOVER_CHROME_HEIGHT
  const listHeight = Math.min(popupMaxHeight, Math.max(MIN_LIST_HEIGHT, available))
  const common = {
    left,
    maxWidth: Math.max(0, viewport.width - VIEWPORT_MARGIN * 2),
    "--anchored-popover-max-height": `${listHeight}px`,
  }

  return placeBelow
    ? { ...common, top: rect.bottom + POPOVER_GAP }
    : {
        ...common,
        top: rect.top - POPOVER_GAP,
        transform: "translateY(-100%)",
      }
}
