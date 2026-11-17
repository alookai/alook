"use client"

import { paginationDiagnostic, paginationDiagnosticId, usePaginationDiagnosticSource } from "@/lib/community/message-pagination-diagnostics"

import { useCallback, useEffect, useRef } from "react"
import type { VirtualItem } from "@tanstack/react-virtual"
import type { MessageRequest } from "@/lib/community/message-position"

export function useVirtualCursorPagination({
  virtualizer, count, enabled = true, hasMore, hasMoreAtStart, isFetching, isError,
  onBeforeLoad, onLoad, edge, requestKey, preloadWithinViewport = false, loadWhenReady = false, diagnosticScope,
}: {
  diagnosticScope?: string | null
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
  const loadInvocations = useRef(0)
  usePaginationDiagnosticSource(`pagination-${edge}`, () => ({ scope: diagnosticScope ?? null, edge, loadInvocations: loadInvocations.current,
    enabled, hasMore: !!hasMore, isFetching: !!isFetching, isError: !!isError, count,
    owner: paginationDiagnosticId(loadInvocations), requestKey: paginationDiagnosticId(requestKey), attempted: attempted.current ? {
      count: attempted.current.count, key: String(attempted.current.key), window: paginationDiagnosticId(attempted.current.window),
      legacy: attempted.current.legacy, pending: attempted.current.pending } : null }))
  const load = useCallback((retry = false) => {
    loadInvocations.current += 1
    const root = preloadWithinViewport ? virtualizer.scrollElement : null
    const rows = virtualizer.getVirtualItems()
    const boundary = edge === "start" ? rows[0] : rows.at(-1)
    if (isFetching && attempted.current?.legacy) attempted.current = null
    if (!enabled || !boundary || count === 0 || !hasMore || isFetching || isError && !retry || retry && !isError || !onLoad) {
      paginationDiagnostic(diagnosticScope, `${edge}.load.rejected`, () => ({ invocation: loadInvocations.current, reason: !enabled ? "disabled"
        : !boundary ? "no-boundary" : count === 0 ? "empty" : !hasMore ? "no-neighbor" : isFetching ? "fetching"
        : isError && !retry ? "error" : retry && !isError ? "not-error-retry" : "no-loader" }))
      return
    }
    let atStart = rows[0]?.index === 0
    let nearEdge = loadWhenReady || (edge === "start" ? boundary.index === 0 : boundary.index === count - 1)
    if (preloadWithinViewport) {
      if (!root || root.clientHeight <= 0) {
        paginationDiagnostic(diagnosticScope, `${edge}.load.rejected`, () => ({ invocation: loadInvocations.current, reason: "viewport" }))
        return
      }
      const start = Math.max(0, root.scrollTop)
      const end = Math.max(0, root.scrollHeight - root.clientHeight - root.scrollTop)
      atStart = start <= root.clientHeight
      nearEdge = (edge === "start" ? start : end) <= root.clientHeight
    }
    if (!nearEdge) {
      paginationDiagnostic(diagnosticScope, `${edge}.load.rejected`, () => ({ invocation: loadInvocations.current, reason: "far-edge" }))
      if (!attempted.current?.pending) attempted.current = null; return
    }
    if (!loadWhenReady && edge === "end" && hasMoreAtStart && atStart) {
      paginationDiagnostic(diagnosticScope, `${edge}.load.rejected`, () => ({ invocation: loadInvocations.current, reason: "short-window-priority" }))
      return
    }
    const key = preloadWithinViewport || loadWhenReady ? edge : boundary.key
    if (attempted.current?.window === requestKey && attempted.current?.pending) {
      paginationDiagnostic(diagnosticScope, `${edge}.load.rejected`, () => ({ invocation: loadInvocations.current, reason: "pending-attempt" }))
      return
    }
    if (!retry && attempted.current?.count === count && attempted.current.key === key && attempted.current.window === requestKey) {
      paginationDiagnostic(diagnosticScope, `${edge}.load.rejected`, () => ({ invocation: loadInvocations.current, reason: "same-attempt" }))
      return
    }
    const attempt = { count, key, window: requestKey, legacy: false, pending: true }
    attempted.current = attempt
    const receive = onBeforeLoad?.()
    if (receive === false) {
      paginationDiagnostic(diagnosticScope, `${edge}.load.rejected`, () => ({ invocation: loadInvocations.current, reason: "anchor-admission" }))
      attempted.current = null; return
    }
    const request = onLoad()
    attempt.legacy = !request
    attempt.pending = !!request?.accepted
    receive?.(request)
    paginationDiagnostic(diagnosticScope, request?.accepted ? `${edge}.load.accepted` : `${edge}.load.rejected`,
      () => ({ invocation: loadInvocations.current, reason: !request ? "legacy-loader" : request.accepted ? "accepted" : "fetch-admission" }))
    if (request?.accepted) {
      const settle = () => { attempt.pending = false }
      void request.completed.then(settle, settle)
    }
  }, [count, diagnosticScope, edge, enabled, hasMore, hasMoreAtStart, isFetching, isError, loadWhenReady, onBeforeLoad, onLoad, preloadWithinViewport, requestKey, virtualizer])
  useEffect(() => {
    const root = preloadWithinViewport ? scrollElement : null
    const onScroll = () => load()
    load()
    root?.addEventListener("scroll", onScroll, { passive: true })
    return () => root?.removeEventListener("scroll", onScroll)
  }, [load, preloadWithinViewport, scrollElement, virtualItems])
  return useCallback(() => load(true), [load])
}
