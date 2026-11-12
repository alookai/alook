"use client"

import { useCallback, useEffect, useRef } from "react"
import type { VirtualItem } from "@tanstack/react-virtual"
import type { MessageRequest } from "@/lib/community/message-position"

export function useVirtualCursorPagination({
  virtualizer, count, enabled = true, hasMore, hasMoreAtStart, isFetching, isError,
  onBeforeLoad, onLoad, edge, requestKey, preloadWithinViewport = false,
}: {
  virtualizer: { getVirtualItems: () => VirtualItem[]; scrollElement?: HTMLElement | null }
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
  preloadWithinViewport?: boolean
}) {
  const virtualItems = virtualizer.getVirtualItems()
  const scrollElement = virtualizer.scrollElement
  const attempted = useRef<{ count: number; key: VirtualItem["key"]; window?: object; legacy: boolean; pending: boolean } | null>(null)
  const load = useCallback((retry = false) => {
    const root = preloadWithinViewport ? virtualizer.scrollElement : null
    const rows = virtualizer.getVirtualItems()
    const boundary = edge === "start" ? rows[0] : rows.at(-1)
    if (isFetching && attempted.current?.legacy) attempted.current = null
    if (!enabled || !boundary || count === 0 || !hasMore || isFetching || isError && !retry || retry && !isError || !onLoad) return
    let atStart = rows[0]?.index === 0
    let nearEdge = edge === "start" ? boundary.index === 0 : boundary.index === count - 1
    if (preloadWithinViewport) {
      if (!root || root.clientHeight <= 0) return
      const start = Math.max(0, root.scrollTop)
      const end = Math.max(0, root.scrollHeight - root.clientHeight - root.scrollTop)
      atStart = start <= root.clientHeight
      nearEdge = (edge === "start" ? start : end) <= root.clientHeight
    }
    if (!nearEdge) { if (!attempted.current?.pending) attempted.current = null; return }
    if (edge === "end" && hasMoreAtStart && atStart) return
    const key = preloadWithinViewport ? edge : boundary.key
    if (attempted.current?.window === requestKey && attempted.current?.pending) return
    if (!retry && attempted.current?.count === count && attempted.current.key === key && attempted.current.window === requestKey) return
    const attempt = { count, key, window: requestKey, legacy: false, pending: true }
    attempted.current = attempt
    const receive = onBeforeLoad?.()
    const request = onLoad()
    attempt.legacy = !request
    attempt.pending = !!request?.accepted
    receive?.(request)
    if (request?.accepted) {
      const settle = () => { attempt.pending = false }
      void request.completed.then(settle, settle)
    }
  }, [count, edge, enabled, hasMore, hasMoreAtStart, isFetching, isError, onBeforeLoad, onLoad, preloadWithinViewport, requestKey, virtualizer])
  useEffect(() => {
    const root = preloadWithinViewport ? scrollElement : null
    const onScroll = () => load()
    load()
    root?.addEventListener("scroll", onScroll, { passive: true })
    return () => root?.removeEventListener("scroll", onScroll)
  }, [load, preloadWithinViewport, scrollElement, virtualItems])
  return useCallback(() => load(true), [load])
}
