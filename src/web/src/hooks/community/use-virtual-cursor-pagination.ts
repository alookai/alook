"use client"

import { useCallback, useEffect, useRef } from "react"
import type { VirtualItem } from "@tanstack/react-virtual"
import type { MessageRequest } from "@/lib/community/message-position"
import { observeMessageReading } from "@/lib/community/message-reading-diagnostic"

export function useVirtualCursorPagination({
  virtualizer, count, enabled = true, hasMore, hasMoreAtStart, isFetching, isError,
  onBeforeLoad, onLoad, edge, requestKey, preloadWithinViewport = false, loadWhenReady = false,
}: {
  virtualizer: { getVirtualItems: () => VirtualItem[]; scrollElement?: HTMLElement | null }
  count: number
  enabled?: boolean
  hasMore?: boolean
  hasMoreAtStart?: boolean
  isFetching?: boolean
  isError?: boolean
  onBeforeLoad?: () => void | false | ((request: MessageRequest | void) => void)
  onLoad?: () => MessageRequest | void
  edge: "start" | "end"
  requestKey?: object
  preloadWithinViewport?: boolean
  loadWhenReady?: boolean
}) {
  const virtualItems = virtualizer.getVirtualItems()
  const scrollElement = virtualizer.scrollElement
  const attempted = useRef<{ count: number; key: VirtualItem["key"]; window?: object; legacy: boolean; pending: boolean } | null>(null)
  const load = useCallback((retry = false) => {
    const root = preloadWithinViewport ? virtualizer.scrollElement : null
    const rows = virtualizer.getVirtualItems()
    const boundary = edge === "start" ? rows[0] : rows.at(-1)
    if (isFetching && attempted.current?.legacy) attempted.current = null
    observeMessageReading("pagination.gate", () => ({ refs: { root: virtualizer.scrollElement, virtualizer, loader: onLoad,
      beforeLoad: onBeforeLoad, requestKey, attempt: attempted.current },
    values: { phase: edge, enabled, boundaryPresent: !!boundary, boundaryIndex: boundary?.index, count, rowCount: rows.length,
      hasMore, hasMoreAtStart, isFetching, isError, retry, loadWhenReady, preloadWithinViewport, callbackPresent: !!onLoad,
      attemptPresent: !!attempted.current, attemptPending: attempted.current?.pending, attemptLegacy: attempted.current?.legacy,
      attemptCount: attempted.current?.count, attemptWindowCurrent: attempted.current?.window === requestKey } }))
    if (!enabled || !boundary || count === 0 || !hasMore || isFetching || isError && !retry || retry && !isError || !onLoad) return
    let atStart = rows[0]?.index === 0
    let nearEdge = loadWhenReady || (edge === "start" ? boundary.index === 0 : boundary.index === count - 1)
    if (preloadWithinViewport) {
      if (!root || root.clientHeight <= 0) return
      const start = Math.max(0, root.scrollTop)
      const end = Math.max(0, root.scrollHeight - root.clientHeight - root.scrollTop)
      atStart = start <= root.clientHeight
      nearEdge = (edge === "start" ? start : end) <= root.clientHeight
    }
    if (!nearEdge) {
      if (!attempted.current?.pending) attempted.current = null
      observeMessageReading("pagination.attempt", () => ({ refs: { virtualizer, loader: onLoad, requestKey, attempt: attempted.current },
        values: { phase: edge, nearEdge, atStart, reason: "near-edge", accepted: false } }))
      return
    }
    if (!loadWhenReady && edge === "end" && hasMoreAtStart && atStart) {
      observeMessageReading("pagination.attempt", () => ({ refs: { virtualizer, loader: onLoad, requestKey },
        values: { phase: edge, nearEdge, atStart, reason: "near-edge", accepted: false } }))
      return
    }
    const key = preloadWithinViewport || loadWhenReady ? edge : boundary.key
    if (attempted.current?.window === requestKey && attempted.current?.pending) {
      observeMessageReading("pagination.attempt", () => ({ refs: { virtualizer, loader: onLoad, requestKey, attempt: attempted.current },
        identities: { boundaryKey: String(key) }, values: { phase: edge, reason: "pending", accepted: false } }))
      return
    }
    if (!retry && attempted.current?.count === count && attempted.current.key === key && attempted.current.window === requestKey) {
      observeMessageReading("pagination.attempt", () => ({ refs: { virtualizer, loader: onLoad, requestKey, attempt: attempted.current },
        identities: { boundaryKey: String(key) }, values: { phase: edge, reason: "deduplicated", accepted: false } }))
      return
    }
    const attempt = { count, key, window: requestKey, legacy: false, pending: true }
    attempted.current = attempt
    observeMessageReading("pagination.attempt", () => ({ refs: { virtualizer, loader: onLoad, requestKey, attempt },
      identities: { boundaryKey: String(key) }, values: { phase: edge, count, nearEdge, atStart, accepted: true } }))
    const receive = onBeforeLoad?.()
    observeMessageReading("pagination.before-load", () => ({ refs: { virtualizer, loader: onLoad, beforeLoad: onBeforeLoad, requestKey, attempt },
      values: { phase: edge, accepted: receive !== false, callbackPresent: typeof receive === "function" } }))
    if (receive === false) { attempted.current = null; return }
    const request = onLoad()
    attempt.legacy = !request
    attempt.pending = !!request?.accepted
    observeMessageReading("pagination.load", () => ({ refs: { virtualizer, loader: onLoad, requestKey, attempt, request: request ?? null },
      values: { phase: edge, requestPresent: !!request, accepted: request?.accepted ?? null, attemptPending: attempt.pending, attemptLegacy: attempt.legacy } }))
    receive?.(request)
    if (request?.accepted) {
      const settle = () => {
        attempt.pending = false
        observeMessageReading("pagination.settle", () => ({ refs: { virtualizer, loader: onLoad, requestKey, attempt, request },
          values: { phase: edge, attemptPending: attempt.pending, attemptWindowCurrent: attempted.current === attempt } }))
      }
      void request.completed.then(settle, settle)
    }
  }, [count, edge, enabled, hasMore, hasMoreAtStart, isFetching, isError, loadWhenReady, onBeforeLoad, onLoad, preloadWithinViewport, requestKey, virtualizer])
  useEffect(() => {
    const root = preloadWithinViewport ? scrollElement : null
    const onScroll = () => load()
    load()
    root?.addEventListener("scroll", onScroll, { passive: true })
    return () => root?.removeEventListener("scroll", onScroll)
  }, [load, preloadWithinViewport, scrollElement, virtualItems])
  return useCallback(() => load(true), [load])
}
