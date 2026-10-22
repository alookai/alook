"use client"

import { useEffect, useRef } from "react"
import type { VirtualItem } from "@tanstack/react-virtual"
import type { MessageRequest } from "@/lib/community/message-position"

export function useVirtualCursorPagination({
  virtualizer, count, enabled = true, hasMore, hasMoreAtStart, isFetching, isError,
  onBeforeLoad, onLoad, edge, requestKey,
}: {
  virtualizer: { getVirtualItems: () => VirtualItem[] }
  count: number
  enabled?: boolean
  hasMore?: boolean
  hasMoreAtStart?: boolean
  isFetching?: boolean
  isError?: boolean
  onBeforeLoad?: () => void | ((request: MessageRequest | void) => void)
  onLoad?: () => MessageRequest | void
  edge: "start" | "end"
  requestKey?: object
}) {
  const virtualItems = virtualizer.getVirtualItems()
  const attempted = useRef<{ count: number; key: VirtualItem["key"]; window?: object; legacy: boolean } | null>(null)
  useEffect(() => {
    const boundary = edge === "start" ? virtualItems[0] : virtualItems.at(-1)
    if (isFetching && attempted.current?.legacy) attempted.current = null
    if (!enabled || !boundary || count === 0 || !hasMore || isFetching || isError || !onLoad) return
    if (edge === "start" ? boundary.index > 0 : boundary.index < count - 1) { attempted.current = null; return }
    if (edge === "end" && hasMoreAtStart && virtualItems[0]?.index === 0) return
    if (attempted.current?.count === count && attempted.current.key === boundary.key && attempted.current.window === requestKey) return
    const attempt = { count, key: boundary.key, window: requestKey, legacy: false }
    attempted.current = attempt
    const receive = onBeforeLoad?.()
    const request = onLoad()
    attempt.legacy = !request
    receive?.(request)
  }, [count, edge, enabled, hasMore, hasMoreAtStart, isFetching, isError, onBeforeLoad, onLoad, requestKey, virtualItems])
}
