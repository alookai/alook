"use client"

import { useCallback, useLayoutEffect, useMemo, useRef, useEffect } from "react"
import { useAtom, useCreateAtom } from "@tanstack/react-store"
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual"
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
 *   - a "Load older" button at the top of the log fetches the next (older)
 *     page on click; the scroll offset is preserved across the prepend so
 *     the row under the eye stays fixed.
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
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
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
  const previousTailKeyRef = useRef<string | null>(null)
  const didInitialTailScrollRef = useRef(false)
  useLayoutEffect(() => {
    setPendingOlderAnchor(null)
    scrollPaddingStartRef.current = 0
    ownsIndexRef.current = false
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
  })

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

  useEffect(() => {
    if (!scrollRoot || !open) return
    const cancel = () => {
      setPendingOlderAnchor(null)
      scrollPaddingStartRef.current = 0
      if (ownsIndexRef.current) virtualizer.scrollToOffset(scrollRoot.scrollTop)
      ownsIndexRef.current = false
      didInitialTailScrollRef.current = true
    }
    const wheel = (event: WheelEvent) => { if (event.deltaY !== 0) cancel() }
    const key = (event: KeyboardEvent) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) cancel()
    }
    scrollRoot.addEventListener("wheel", wheel, { passive: true })
    scrollRoot.addEventListener("touchstart", cancel, { passive: true })
    scrollRoot.addEventListener("pointerdown", cancel)
    scrollRoot.addEventListener("keydown", key)
    return () => {
      scrollRoot.removeEventListener("wheel", wheel)
      scrollRoot.removeEventListener("touchstart", cancel)
      scrollRoot.removeEventListener("pointerdown", cancel)
      scrollRoot.removeEventListener("keydown", key)
    }
  }, [open, scrollRoot, setPendingOlderAnchor, virtualizer])

  const onLoadOlder = () => {
    if (!hasNextPage || isFetchingNextPage) return
    const offset = virtualizer.scrollOffset ?? 0
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
    void fetchNextPage().then(settle, () => settle(null))
  }

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
      bodyRef={setScrollRoot}
      bodyClassName="bg-background p-0"
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
                    <button
                      type="button"
                      onClick={onLoadOlder}
                      disabled={isFetchingNextPage}
                      className="min-h-11 rounded-md px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60 sm:min-h-8"
                    >
                      {isFetchingNextPage ? "Loading older" : "Load older"}
                    </button>
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
