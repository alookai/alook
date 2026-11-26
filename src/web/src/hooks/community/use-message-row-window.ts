"use client"

import { useCallback, useLayoutEffect, useMemo, useState, type RefObject } from "react"
import type { FlatItem } from "@/lib/community/message-list-items"

const MESSAGE_ROW_WINDOW_THRESHOLD = 200
const MESSAGE_ROW_ESTIMATE_PX = 72
const NON_MESSAGE_ROW_ESTIMATE_PX = 40
const MESSAGE_ROW_OVERSCAN = 16
const DEFAULT_VIEWPORT_HEIGHT_PX = 800

function estimateItemHeight(item: FlatItem): number {
  return item.kind === "message" ? MESSAGE_ROW_ESTIMATE_PX : NON_MESSAGE_ROW_ESTIMATE_PX
}

function findPinnedIndex(items: readonly FlatItem[], pinnedIds: ReadonlyArray<string | null | undefined>): number | null {
  for (const targetId of pinnedIds) {
    if (!targetId) continue
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!
      if (item.kind === "message" && item.m.id === targetId) return i
      if (item.kind === "divider" && item.newDivider && item.messageId === targetId) return i
    }
  }
  return null
}

function computeWindowSlice(
  items: readonly FlatItem[],
  heights: ReadonlyMap<string, number>,
  scrollTop: number,
  viewportHeight: number,
  hasScrollMeasurement: boolean,
  pinnedIndex: number | null,
): { startIndex: number; endIndex: number; topSpacerHeight: number; bottomSpacerHeight: number } {
  const count = items.length
  if (count <= MESSAGE_ROW_WINDOW_THRESHOLD) {
    return { startIndex: 0, endIndex: count, topSpacerHeight: 0, bottomSpacerHeight: 0 }
  }

  const effectiveViewport = viewportHeight > 0 ? viewportHeight : DEFAULT_VIEWPORT_HEIGHT_PX
  const visibleEstimate = Math.max(8, Math.ceil(effectiveViewport / MESSAGE_ROW_ESTIMATE_PX))

  const offsets = new Float64Array(count + 1)
  for (let i = 0; i < count; i++) {
    const item = items[i]!
    const h = heights.get(item.key) ?? estimateItemHeight(item)
    offsets[i + 1] = offsets[i]! + h
  }
  const totalHeight = offsets[count]!

  let startIndex: number
  let endIndex: number

  if (!hasScrollMeasurement) {
    if (pinnedIndex !== null) {
      const half = Math.ceil(visibleEstimate / 2) + MESSAGE_ROW_OVERSCAN
      startIndex = Math.max(0, pinnedIndex - half)
      endIndex = Math.min(count, pinnedIndex + half)
    } else {
      endIndex = count
      startIndex = Math.max(0, count - (visibleEstimate + MESSAGE_ROW_OVERSCAN * 2))
    }
  } else {
    const clampedTop = Math.max(0, Math.min(scrollTop, Math.max(0, totalHeight - effectiveViewport)))
    const viewBottom = clampedTop + effectiveViewport

    // Binary search for first index whose bottom > clampedTop
    let lo = 0
    let hi = count - 1
    let firstVisible = count - 1
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1
      if (offsets[mid + 1]! > clampedTop) {
        firstVisible = mid
        hi = mid - 1
      } else {
        lo = mid + 1
      }
    }

    // Binary search for last index whose top < viewBottom
    lo = firstVisible
    hi = count - 1
    let lastVisible = firstVisible
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1
      if (offsets[mid]! < viewBottom) {
        lastVisible = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }

    startIndex = Math.max(0, firstVisible - MESSAGE_ROW_OVERSCAN)
    endIndex = Math.min(count, lastVisible + 1 + MESSAGE_ROW_OVERSCAN)

    // If a jump target / anchor is outside the current window, shift the window to cover it
    // so scroll positioning can measure and land on its DOM element.
    if (pinnedIndex !== null && (pinnedIndex < startIndex || pinnedIndex >= endIndex)) {
      const half = Math.ceil(visibleEstimate / 2) + MESSAGE_ROW_OVERSCAN
      startIndex = Math.max(0, pinnedIndex - half)
      endIndex = Math.min(count, pinnedIndex + half)
    }
  }

  return {
    startIndex,
    endIndex,
    topSpacerHeight: Math.round(offsets[startIndex]!),
    bottomSpacerHeight: Math.round(totalHeight - offsets[endIndex]!),
  }
}

const rowHeightCaches = new WeakMap<object, Map<string, number>>()

function getRowHeightCache(token: object): Map<string, number> {
  let cache = rowHeightCaches.get(token)
  if (!cache) {
    cache = new Map<string, number>()
    rowHeightCaches.set(token, cache)
  }
  return cache
}

export function useMessageRowWindow({
  items,
  scrollRef,
  pinnedIds = [],
}: {
  items: readonly FlatItem[]
  scrollRef: RefObject<HTMLDivElement | null>
  pinnedIds?: ReadonlyArray<string | null | undefined>
}) {
  const heightCacheToken = useMemo(() => ({}), [])
  const [viewport, setViewport] = useState<{ scrollTop: number; height: number; measured: boolean }>({
    scrollTop: 0,
    height: 0,
    measured: false,
  })

  const windowEnabled = items.length > MESSAGE_ROW_WINDOW_THRESHOLD

  useLayoutEffect(() => {
    const root = scrollRef.current
    if (!root || !windowEnabled) return
    let rafId: number | null = null

    const sync = () => {
      rafId = null
      const height = root.clientHeight
      const scrollHeight = root.scrollHeight
      const measured = height > 0 && scrollHeight > 0
      const scrollTop = root.scrollTop
      setViewport((current) => {
        if (current.measured === measured && Math.abs(current.scrollTop - scrollTop) < 16 && current.height === height) {
          return current
        }
        return { scrollTop, height, measured }
      })
    }

    const scheduleSync = () => {
      if (rafId !== null) return
      rafId = window.requestAnimationFrame(sync)
    }

    sync()
    root.addEventListener("scroll", scheduleSync, { passive: true })
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(scheduleSync) : null
    ro?.observe(root)

    return () => {
      root.removeEventListener("scroll", scheduleSync)
      ro?.disconnect()
      if (rafId !== null) window.cancelAnimationFrame(rafId)
    }
  }, [scrollRef, windowEnabled])

  const measureRow = useCallback((key: string, element: HTMLElement | null) => {
    if (!element) return
    const height = element.getBoundingClientRect().height || element.offsetHeight
    if (height > 0) {
      getRowHeightCache(heightCacheToken).set(key, Math.ceil(height))
    }
  }, [heightCacheToken])

  const pinnedIndex = useMemo(
    () => (windowEnabled ? findPinnedIndex(items, pinnedIds) : null),
    [items, pinnedIds, windowEnabled],
  )

  const slice = useMemo(
    () =>
      computeWindowSlice(
        items,
        getRowHeightCache(heightCacheToken),
        viewport.scrollTop,
        viewport.height,
        viewport.measured,
        pinnedIndex,
      ),
    [heightCacheToken, items, pinnedIndex, viewport.height, viewport.measured, viewport.scrollTop],
  )

  return {
    windowed: windowEnabled,
    startIndex: slice.startIndex,
    endIndex: slice.endIndex,
    topSpacerHeight: slice.topSpacerHeight,
    bottomSpacerHeight: slice.bottomSpacerHeight,
    measureRow,
  }
}
