"use client"

import { useEffect } from "react"
import type { VirtualItem } from "@tanstack/react-virtual"

export function useVirtualCursorPagination({
  virtualizer, count, enabled = true, hasMore, hasMoreAtStart, isFetching, isSettling, isError,
  onBeforeLoad, onLoad, edge,
}: {
  virtualizer: { getVirtualItems: () => VirtualItem[] }
  count: number
  enabled?: boolean
  hasMore?: boolean
  hasMoreAtStart?: boolean
  isFetching?: boolean
  isSettling?: boolean
  isError?: boolean
  onBeforeLoad?: () => void
  onLoad?: () => void
  edge: "start" | "end"
}) {
  const virtualItems = virtualizer.getVirtualItems()
  useEffect(() => {
    const boundary = edge === "start" ? virtualItems[0] : virtualItems.at(-1)
    if (!enabled || !boundary || count === 0 || !hasMore || isFetching || isSettling || isError || !onLoad) return
    if (edge === "start" ? boundary.index > 0 : boundary.index < count - 1) return
    if (edge === "end" && hasMoreAtStart && virtualItems[0]?.index === 0) return
    onBeforeLoad?.()
    onLoad()
  }, [count, edge, enabled, hasMore, hasMoreAtStart, isFetching, isSettling, isError, onBeforeLoad, onLoad, virtualItems])
}
