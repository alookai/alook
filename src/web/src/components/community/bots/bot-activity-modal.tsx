"use client"

import { useCallback, useLayoutEffect, useMemo, useRef, useEffect } from "react"
import { useAtom, useCreateAtom } from "@tanstack/react-store"
import { defaultRangeExtractor, useVirtualizer, type Range, type VirtualItem } from "@tanstack/react-virtual"
import { AgentAvatar } from "@/components/avatar"
import { CommunitySheet } from "@/components/community/shell/community-sheet"
import { useCanonicalCommunityProfile } from "@/lib/community-db/projections"
import {
  useBotAuditLog,
  type AuditEvent,
} from "@/hooks/community/use-bot-audit-log"
import type { BotSummary } from "@/hooks/community/use-bots"
import { tid } from "@/lib/community/testids"
import { BotActivityRow } from "./bot-activity-row"

/**
 * Modal audit log for one bot. Owner-only surface (the API enforces 404 for
 * non-owners); opens over the current /c/me/bots view rather than
 * pushing a route.
 *
 * Reads like a developer log tail:
 *   - oldest at the top, newest at the bottom (sorted by (createdAt, id));
 *   - auto-scrolls to the tail on open and on new live rows (only when the
 *     user was already near the tail — a reader scrolled up to inspect
 *     history is not yanked back);
 *   - upward reading near the top fetches the next older page; the row under
 *     the eye stays fixed across the prepend, with explicit retry on failure.
 *
 * Day dividers group rows chronologically without adding per-row chrome.
 */
export function BotActivityModal({
  bot,
  open,
  onOpenChange,
  onOpenChangeComplete,
}: {
  bot: BotSummary | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onOpenChangeComplete: (open: boolean) => void
}) {
  // "Live" here means the bot's daemon is currently connected (its WS
  // presence). A viewer with a broken WS wouldn't receive events either, but
  // the daemon-side signal is what determines whether new rows are actually
  // being produced right now.
  const profile = useCanonicalCommunityProfile(bot?.id)
  const online = profile?.presence === "online"
  const {
    events,
    isLoading,
    isFetching,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
    loadedPageCount,
  } = useBotAuditLog(bot?.id ?? null)

  // Merged stream = paginated GET (DESC) + live WS ring (arrival-ordered).
  // The two are NOT a single monotonic sequence: a live event can carry a
  // `createdAt` that interleaves with an older page, and a paginated older
  // page prepends rows whose timestamps sit before the live tail. Sort
  // once by `(createdAt, id)` ascending so the UI is chronological
  // end-to-end — reversing alone would leave that jumbled.
  const chronological = useMemo(() => {
    return [...events].sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
  }, [events])

  const rows = useMemo(() => flattenActivityRows(chronological, bot?.id ?? ""), [chronological, bot?.id])
  const [scrollRoot, setScrollRoot] = useAtom(useCreateAtom<HTMLDivElement | null>(null))
  const setLogBody = useCallback((element: HTMLDivElement | null) => {
    if (element) {
      element.tabIndex = 0
      element.setAttribute("role", "region")
      element.setAttribute("aria-label", "Activity log")
    }
    setScrollRoot(element)
  }, [setScrollRoot])
  const stickyIndexes = useMemo(() => rows.flatMap((row, index) => row.kind === "date" ? [index] : []), [rows])
  const activeStickyIndexRef = useRef<number | null>(null)
  const [pendingOlderAnchor, setPendingOlderAnchor] = useAtom(useCreateAtom<{
    key: string
    viewportOffset: number
    pageCount: number
    receivedOlderRows: boolean
    settled: boolean
  } | null>(null))
  const scrollPaddingStartRef = useRef(0)
  const ownsIndexRef = useRef(false)
  const readingInputRef = useRef<{
    offset: number
    height: number
    totalSize: number
    fold: Pick<VirtualItem, "key" | "start" | "size"> | null
  } | null>(null)
  const previousTailKeyRef = useRef<string | null>(null)
  const didInitialTailScrollRef = useRef(false)
  useLayoutEffect(() => {
    setPendingOlderAnchor(null)
    scrollPaddingStartRef.current = 0
    ownsIndexRef.current = false
    readingInputRef.current = null
    previousTailKeyRef.current = null
    didInitialTailScrollRef.current = false
  }, [open, bot?.id, scrollRoot, setPendingOlderAnchor])

  const getItemKey = useCallback((index: number) => rows[index].key, [rows])
  const estimateSize = useCallback((index: number) => rows[index].kind === "date" ? 24 : 44, [rows])
  const rangeExtractor = useCallback((range: Range) => {
    const active = [...stickyIndexes].reverse().find((index) => index <= range.startIndex) ?? null
    activeStickyIndexRef.current = active
    return [...new Set([
      ...(active === null ? [] : [active]),
      ...defaultRangeExtractor(range),
    ])].sort((a, b) => a - b)
  }, [stickyIndexes])
  // eslint-disable-next-line react-hooks/incompatible-library -- supported TanStack Virtual imperative adapter
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRoot,
    getItemKey,
    estimateSize,
    rangeExtractor,
    anchorTo: "end",
    followOnAppend: open && didInitialTailScrollRef.current && !isFetchingNextPage && !pendingOlderAnchor,
    scrollEndThreshold: 80,
    scrollPaddingStart: scrollPaddingStartRef.current,
    paddingEnd: 12,
    overscan: 8,
    enabled: scrollRoot !== null,
    useFlushSync: false,
    onChange: (instance) => {
      if (!instance.isScrolling) readingInputRef.current = null
    },
  })

  useLayoutEffect(() => () => virtualizer.cancelScroll(), [open, bot?.id, scrollRoot, virtualizer])

  useLayoutEffect(() => {
    if (!open || !scrollRoot || chronological.length === 0) return
    if (!didInitialTailScrollRef.current && scrollRoot.clientHeight > 0
      && scrollRoot.querySelector("[data-activity-event-id]")) {
      didInitialTailScrollRef.current = true
      ownsIndexRef.current = true
      virtualizer.scrollToEnd()
    }
    const tailKey = rows.at(-1)?.key ?? null
    if (previousTailKeyRef.current && tailKey !== previousTailKeyRef.current
      && virtualizer.options.followOnAppend && virtualizer.isAtEnd(80)) ownsIndexRef.current = true
    previousTailKeyRef.current = tailKey
    const pending = pendingOlderAnchor
    if (!pending || !pending.settled || isFetchingNextPage) return
    setPendingOlderAnchor(null)
    if (pending.receivedOlderRows) {
      const index = rows.findIndex((row) => row.key === pending.key)
      if (index >= 0) {
        scrollPaddingStartRef.current = pending.viewportOffset
        virtualizer.setOptions({ ...virtualizer.options, scrollPaddingStart: pending.viewportOffset })
        ownsIndexRef.current = true
        virtualizer.scrollToIndex(index, { align: "start" })
      }
    }
  })

  const onLoadOlder = useCallback((retry = false) => {
    if (!open || !bot?.id || !scrollRoot || scrollRoot.clientHeight <= 0
      || !didInitialTailScrollRef.current || !hasNextPage || isFetching
      || (!retry && (isFetchNextPageError || ownsIndexRef.current))) return
    const offset = scrollRoot.scrollTop
    const fold = virtualizer.getVirtualItemForOffset(offset)
    let pending: typeof pendingOlderAnchor = null
    if (fold && rows[fold.index]?.kind !== "event") {
      const event = virtualizer.getVirtualItems().find((item) => rows[item.index]?.kind === "event" && item.end > offset)
      if (event) pending = {
        key: String(event.key),
        viewportOffset: event.start - offset,
        pageCount: loadedPageCount,
        receivedOlderRows: false,
        settled: false,
      }
    }
    setPendingOlderAnchor(pending)
    const settle = (result: Awaited<ReturnType<typeof fetchNextPage>> | null) => {
      if (!pending) return
      setPendingOlderAnchor(current => current === pending ? {
        ...current,
        settled: true,
        receivedOlderRows: Boolean(result && !result.isError
          && result.data?.pages.slice(current.pageCount).some(page => page.events.length > 0)),
      } : current)
    }
    void fetchNextPage({ cancelRefetch: false }).then(settle, () => settle(null))
  }, [open, bot?.id, scrollRoot, hasNextPage, isFetching, isFetchNextPageError, rows, loadedPageCount, fetchNextPage, setPendingOlderAnchor, virtualizer])

  useEffect(() => {
    if (!scrollRoot || !open) return
    let previousOffset = scrollRoot.scrollTop
    let touchY: number | null = null
    let pointerId: number | null = null
    const cancel = () => {
      readingInputRef.current = null
      setPendingOlderAnchor(null)
      scrollPaddingStartRef.current = 0
      virtualizer.cancelScroll()
      ownsIndexRef.current = false
      didInitialTailScrollRef.current = true
    }
    const qualifyInput = () => {
      const offset = scrollRoot.scrollTop
      const fold = virtualizer.getVirtualItemForOffset(offset)
      readingInputRef.current = {
        offset,
        height: scrollRoot.clientHeight,
        totalSize: virtualizer.getTotalSize(),
        fold: fold ? { key: fold.key, start: fold.start, size: fold.size } : null,
      }
    }
    const load = () => {
      readingInputRef.current = null
      onLoadOlder()
    }
    const scroll = () => {
      const offset = scrollRoot.scrollTop
      const upwards = offset < previousOffset
      const downwards = offset > previousOffset
      previousOffset = offset
      const input = readingInputRef.current
      if (!input) return
      const fold = virtualizer.getVirtualItemForOffset(input.offset)
      if (downwards || scrollRoot.clientHeight !== input.height || virtualizer.getTotalSize() !== input.totalSize
        || (fold?.key ?? null) !== (input.fold?.key ?? null)
        || fold?.start !== input.fold?.start || fold?.size !== input.fold?.size) {
        readingInputRef.current = null
        return
      }
      if (upwards && offset <= 160) load()
    }
    const wheel = (event: WheelEvent) => {
      if (event.deltaY === 0) return
      cancel()
      if (event.deltaY < 0) {
        qualifyInput()
        if (scrollRoot.scrollTop <= 0) load()
      }
    }
    const touchStart = (event: TouchEvent) => {
      pointerId = null
      touchY = event.touches[0]?.clientY ?? null
      cancel()
    }
    const touchMove = (event: TouchEvent) => {
      const nextY = event.touches[0]?.clientY ?? null
      if (touchY !== null && nextY !== null && nextY !== touchY) {
        if (nextY > touchY) {
          qualifyInput()
          if (scrollRoot.scrollTop <= 0) load()
        } else readingInputRef.current = null
      }
      touchY = nextY
    }
    const touchEnd = () => { touchY = null }
    const touchCancel = () => {
      touchY = null
      readingInputRef.current = null
    }
    const pointerDown = (event: PointerEvent) => {
      cancel()
      if (event.button === 0 && event.pointerType !== "touch") {
        pointerId = event.pointerId
        qualifyInput()
      }
    }
    const pointerMove = (event: PointerEvent) => {
      if (pointerId !== null && event.pointerId === pointerId) qualifyInput()
    }
    const pointerEnd = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return
      scroll()
      pointerId = null
      readingInputRef.current = null
    }
    const pointerCancel = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return
      pointerId = null
      readingInputRef.current = null
    }
    const key = (event: KeyboardEvent) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) cancel()
      if (["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey)) {
        qualifyInput()
        if (scrollRoot.scrollTop <= 0) load()
      }
    }
    scrollRoot.addEventListener("scroll", scroll, { passive: true })
    scrollRoot.addEventListener("wheel", wheel, { passive: true })
    scrollRoot.addEventListener("touchstart", touchStart, { passive: true })
    scrollRoot.addEventListener("touchmove", touchMove, { passive: true })
    scrollRoot.addEventListener("touchend", touchEnd, { passive: true })
    scrollRoot.addEventListener("touchcancel", touchCancel, { passive: true })
    scrollRoot.addEventListener("pointerdown", pointerDown)
    window.addEventListener("pointermove", pointerMove, { passive: true })
    window.addEventListener("pointerup", pointerEnd, { passive: true })
    window.addEventListener("pointercancel", pointerCancel, { passive: true })
    scrollRoot.addEventListener("keydown", key)
    return () => {
      readingInputRef.current = null
      scrollRoot.removeEventListener("scroll", scroll)
      scrollRoot.removeEventListener("wheel", wheel)
      scrollRoot.removeEventListener("touchstart", touchStart)
      scrollRoot.removeEventListener("touchmove", touchMove)
      scrollRoot.removeEventListener("touchend", touchEnd)
      scrollRoot.removeEventListener("touchcancel", touchCancel)
      scrollRoot.removeEventListener("pointerdown", pointerDown)
      window.removeEventListener("pointermove", pointerMove)
      window.removeEventListener("pointerup", pointerEnd)
      window.removeEventListener("pointercancel", pointerCancel)
      scrollRoot.removeEventListener("keydown", key)
    }
  }, [open, scrollRoot, onLoadOlder, setPendingOlderAnchor, virtualizer])

  return (
    <CommunitySheet
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={onOpenChangeComplete}
      title={bot?.name ?? "Bot"}
      headerLeading={(
        <AgentAvatar name={bot?.name ?? ""} avatarUrl={bot?.image ?? null} seed={bot?.id} size={32} />
      )}
      description={(
        <span className="flex items-center gap-1.5">
          <span
            className={[
              "inline-block size-1.5 rounded-full",
              online ? "bg-status-online" : "bg-muted-foreground/60",
            ].join(" ")}
            aria-hidden
          />
          <span>{online ? "Live" : "Offline"}</span>
          <span aria-hidden className="text-muted-foreground/40">·</span>
          <span>Activity log</span>
        </span>
      )}
      desktopWidth={672}
      resizable
      contentTestId={tid.botActivityModal}
      bodyRef={setLogBody}
      bodyClassName="bg-background p-0 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:outline-none"
    >
      {isLoading && chronological.length === 0 ? (
        <SkeletonRows />
      ) : chronological.length === 0 ? (
        <EmptyState />
      ) : (
        <div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const row = rows[virtualRow.index]
            const sticky = row.kind === "date" && virtualRow.index === activeStickyIndexRef.current
            return (
              <div
                key={virtualRow.key}
                ref={virtualizer.measureElement}
                data-index={virtualRow.index}
                data-activity-row-key={row.key}
                data-activity-event-id={row.kind === "event" ? row.event.id : undefined}
                style={{
                  position: sticky ? "sticky" : "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  zIndex: row.kind === "date" ? 10 : undefined,
                  transform: sticky ? undefined : `translateY(${virtualRow.start}px)`,
                }}
              >
                {row.kind === "event" ? <BotActivityRow event={row.event} /> : row.kind === "date" ? <DayDivider label={row.label} /> : hasNextPage ? (
                  <div className="flex justify-center py-2">
                    {isFetchNextPageError ? <button
                      type="button"
                      onClick={() => onLoadOlder(true)}
                      disabled={isFetching}
                      className="min-h-11 rounded-md px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60 sm:min-h-8"
                    >
                      {isFetchingNextPage ? "Loading older" : "Retry older"}
                    </button> : <span role="status" className="py-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                      {isFetchingNextPage ? "Loading older" : "Scroll up for older"}
                    </span>}
                  </div>
                ) : (
                  <div className="py-2 text-center font-mono text-[10px] uppercase tracking-wider text-muted-foreground/40">
                    Beginning of log
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </CommunitySheet>
  )
}

function DayDivider({ label }: { label: string }) {
  return (
    <div className="border-b border-border/40 bg-background/95 px-4 py-1 backdrop-blur supports-backdrop-filter:bg-background/80">
      <span className="font-mono text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
    </div>
  )
}

function SkeletonRows() {
  return (
    <div className="flex flex-col gap-2 p-4">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <div className="h-3 w-16 animate-pulse rounded bg-muted/40" />
          <div className="h-3 w-10 animate-pulse rounded bg-muted/30" />
          <div className="h-3 flex-1 animate-pulse rounded bg-muted/40" />
        </div>
      ))}
    </div>
  )
}

function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/60">
        No activity yet
      </div>
      <p className="max-w-xs text-xs text-muted-foreground">
        This bot hasn&apos;t run since audit logging was enabled. New runs
        will stream in here as they happen.
      </p>
    </div>
  )
}

type ActivityRow =
  | { kind: "control"; key: string }
  | { kind: "date"; key: string; label: string }
  | { kind: "event"; key: string; event: AuditEvent }

function flattenActivityRows(events: AuditEvent[], botId: string): ActivityRow[] {
  if (events.length === 0) return []
  const rows: ActivityRow[] = [{ kind: "control", key: `${botId}:control` }]
  let previousDay: string | undefined
  for (const event of events) {
    const key = dayKey(event.createdAt)
    if (key !== previousDay) {
      rows.push({ kind: "date", key: `${botId}:date:${key}`, label: formatDayLabel(event.createdAt) })
      previousDay = key
    }
    rows.push({ kind: "event", key: `${botId}:event:${event.id}`, event })
  }
  return rows
}

function dayKey(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

function formatDayLabel(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000)
  if (days === 0) return "Today"
  if (days === 1) return "Yesterday"
  if (days < 7) {
    return d.toLocaleDateString(undefined, { weekday: "long" })
  }
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: d.getFullYear() === now.getFullYear() ? undefined : "numeric",
  })
}
