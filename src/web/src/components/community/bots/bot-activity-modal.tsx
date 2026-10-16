"use client"

import { useCallback, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react"
import { useAtom, useCreateAtom } from "@tanstack/react-store"
import { useVirtualizer } from "@tanstack/react-virtual"
import { useVirtualCursorPagination } from "@/hooks/community/use-virtual-cursor-pagination"
import { AgentAvatar } from "@/components/avatar"
import { CommunitySheet } from "@/components/community/shell/community-sheet"
import { useCanonicalCommunityProfile } from "@/lib/community-db/projections"
import { useBotAuditLog } from "@/hooks/community/use-bot-audit-log"
import type { BotSummary } from "@/hooks/community/use-bots"
import { tid } from "@/lib/community/testids"
import { BotActivityRow } from "./bot-activity-row"

const DAY_DIVIDER_HEIGHT = 33

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

  const dateAfter = useMemo(() => chronological.map((event, index) => {
    const next = chronological[index + 1]
    return next && dayKey(next.createdAt) !== dayKey(event.createdAt) ? next.createdAt : null
  }), [chronological])
  const [scrollRoot, setScrollRoot] = useAtom(useCreateAtom<HTMLDivElement | null>(null))
  const [initialized, setInitialized] = useAtom(useCreateAtom(false))
  const setLogBody = useCallback((element: HTMLDivElement | null) => {
    if (element) {
      element.tabIndex = 0
      element.setAttribute("role", "region")
      element.setAttribute("aria-label", "Activity log")
    }
    setScrollRoot(element)
  }, [setScrollRoot])
  const getItemKey = useCallback((index: number) => `${bot?.id ?? ""}:event:${chronological[index].id}`, [chronological, bot?.id])
  const estimateSize = useCallback((index: number) => 44 + (dateAfter[index] ? DAY_DIVIDER_HEIGHT : 0), [dateAfter])
  const visibleDateListener = useRef<(() => void) | undefined>(undefined)
  const notifyVisibleDate = useCallback(() => visibleDateListener.current?.(), [])
  // eslint-disable-next-line react-hooks/incompatible-library -- supported TanStack Virtual imperative adapter
  const virtualizer = useVirtualizer({
    directDomUpdates: true,
    onChange: notifyVisibleDate,
    count: chronological.length,
    getScrollElement: () => scrollRoot,
    getItemKey,
    estimateSize,
    anchorTo: "end",
    followOnAppend: initialized,
    scrollEndThreshold: 80,
    paddingStart: DAY_DIVIDER_HEIGHT,
    paddingEnd: 12,
    overscan: 8,
    enabled: scrollRoot !== null,
  })
  useLayoutEffect(() => {
    setInitialized(false)
    return () => virtualizer.cancelScroll()
  }, [open, bot?.id, scrollRoot, setInitialized, virtualizer])
  useLayoutEffect(() => {
    if (!open || initialized || !scrollRoot || scrollRoot.clientHeight <= 0 || chronological.length === 0
      || !scrollRoot.querySelector("[data-activity-event-id]")) return
    virtualizer.scrollToEnd()
    setInitialized(true)
  })
  const subscribeVisibleDate = useCallback((listener: () => void) => {
    visibleDateListener.current = listener
    scrollRoot?.addEventListener("scroll", listener)
    return () => {
      if (visibleDateListener.current === listener) visibleDateListener.current = undefined
      scrollRoot?.removeEventListener("scroll", listener)
    }
  }, [scrollRoot])
  const getVisibleDate = useCallback(() => {
    const items = virtualizer.getVirtualItems()
    const offset = (virtualizer.scrollOffset ?? 0) + DAY_DIVIDER_HEIGHT
    const item = items.find(row => row.end - (dateAfter[row.index] ? DAY_DIVIDER_HEIGHT : 0) > offset)
      ?? items.at(-1)
    return chronological[item?.index ?? 0]?.createdAt ?? ""
  }, [virtualizer, dateAfter, chronological])
  const visibleDate = useSyncExternalStore(subscribeVisibleDate, getVisibleDate, getVisibleDate)
  const virtualItems = virtualizer.getVirtualItems()
  const loadOlder = useCallback(() => {
    void fetchNextPage({ cancelRefetch: false })
  }, [fetchNextPage])
  useVirtualCursorPagination({
    virtualizer,
    count: chronological.length,
    enabled: open && initialized && Boolean(scrollRoot?.clientHeight),
    hasMore: hasNextPage,
    isFetching: isFetching || isFetchingNextPage,
    isError: isFetchNextPageError,
    onLoad: loadOlder,
    edge: "start",
  })

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
      footer={isFetchNextPageError ? (
        <button
          type="button"
          onClick={loadOlder}
          disabled={isFetching}
          className="min-h-11 rounded-md px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60 sm:min-h-8"
        >
          Retry older
        </button>
      ) : undefined}
      contentTestId={tid.botActivityModal}
      bodyRef={setLogBody}
      bodyClassName="bg-background p-0 [overflow-anchor:none] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:outline-none"
    >
      {isLoading && chronological.length === 0 ? (
        <SkeletonRows />
      ) : chronological.length === 0 ? (
        <EmptyState />
      ) : (
        <div ref={virtualizer.containerRef} style={{ position: "relative", width: "100%" }}>
          <div className="sticky top-0 z-10" data-activity-sticky-date={dayKey(visibleDate)}>
            <DayDivider date={visibleDate} />
          </div>
          {virtualItems.map((virtualRow) => {
            const event = chronological[virtualRow.index]
            const nextDate = dateAfter[virtualRow.index]
            return (
              <div
                key={virtualRow.key}
                ref={virtualizer.measureElement}
                data-index={virtualRow.index}
                data-activity-row-key={virtualRow.key}
                data-activity-event-id={event.id}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                }}
              >
                <BotActivityRow event={event} />
                {nextDate && <DayDivider date={nextDate} />}
              </div>
            )
          })}
        </div>
      )}
    </CommunitySheet>
  )
}

function DayDivider({ date }: { date: string }) {
  return (
    <div
      data-activity-date={dayKey(date)}
      className="border-b border-border/40 bg-background/95 px-4 py-1 backdrop-blur supports-backdrop-filter:bg-background/80"
      style={{ height: DAY_DIVIDER_HEIGHT }}
    >
      <span className="font-mono text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {formatDayLabel(date)}
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
