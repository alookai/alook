"use client"

import { useLayoutEffect, useMemo, useRef, useEffect } from "react"
import { AgentAvatar } from "@/components/avatar"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { useOnlineUserIds } from "@/stores/community/ws"
import {
  useBotAuditLog,
  type AuditEvent,
} from "@/hooks/community/use-bot-audit-log"
import type { BotSummary } from "@/hooks/community/use-bots"
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
}: {
  bot: BotSummary | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  // "Live" here means the bot's daemon is currently connected (its WS
  // presence). A viewer with a broken WS wouldn't receive events either, but
  // the daemon-side signal is what determines whether new rows are actually
  // being produced right now.
  const online = useOnlineUserIds().has(bot?.id ?? "")
  const {
    events,
    isLoading,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useBotAuditLog(open ? bot?.id : null)

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

  // Chronologically-adjacent rows are grouped under a shared day header,
  // rendered when the day boundary changes. Cheap to compute at the render
  // scale we operate at (500-row cap per bot).
  const grouped = useMemo(() => groupByDay(chronological), [chronological])

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const bottomAnchorRef = useRef<HTMLDivElement | null>(null)
  const lastCountRef = useRef(0)
  const pendingOlderAnchorRef = useRef<number | null>(null)
  const didInitialTailScrollRef = useRef(false)

  const onLoadOlder = () => {
    if (!hasNextPage || isFetchingNextPage) return
    const el = scrollRef.current
    if (el) pendingOlderAnchorRef.current = el.scrollHeight
    void fetchNextPage()
  }

  // Reset the once-per-open latch when the modal closes or the target bot
  // changes, so the next open lands on the newest event again.
  useEffect(() => {
    if (!open) {
      lastCountRef.current = 0
      pendingOlderAnchorRef.current = null
      didInitialTailScrollRef.current = false
    }
  }, [open, bot?.id])

  // Snap to the newest event on first paint of an open cycle. The Radix
  // Dialog mounts DialogContent inside a portal with an entrance animation,
  // so relying on a `useLayoutEffect` that only fires when
  // `chronological.length` changes can race the portal's first layout — the
  // scroll fires before the container has its final height. Anchor + rAF
  // guarantees the browser has laid out at least once before we jump.
  useEffect(() => {
    if (!open) return
    if (didInitialTailScrollRef.current) return
    if (chronological.length === 0) return
    const anchor = bottomAnchorRef.current
    const el = scrollRef.current
    if (!anchor || !el) return
    didInitialTailScrollRef.current = true
    lastCountRef.current = chronological.length
    // Two rAFs: one to let the portal layout settle, one to jump after the
    // rows are actually painted. `scrollIntoView({ block: 'end' })` is
    // instant (no smooth-scroll) so the reader doesn't see it move.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        anchor.scrollIntoView({ block: "end" })
        // Belt-and-braces: if the anchor was already in view before jumping,
        // browsers sometimes no-op scrollIntoView — pin scrollTop explicitly.
        el.scrollTop = el.scrollHeight
      })
    })
  }, [open, chronological.length])

  // After the initial tail scroll, handle two ongoing cases:
  //   1. `pendingOlderAnchorRef` set — Load older prepended rows; preserve
  //      the reader's visible offset by shifting scrollTop by the height delta.
  //   2. A new live event arrived and the reader was already near the tail —
  //      keep the tail pinned so streaming rows stay visible.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const prevCount = lastCountRef.current
    const nextCount = chronological.length
    lastCountRef.current = nextCount
    if (nextCount === 0) return

    if (pendingOlderAnchorRef.current !== null) {
      // Only consume the anchor when rows were actually prepended. An older-page
      // fetch that settles with zero new rows leaves the pending anchor stale;
      // applying its `delta` on a later live-event render would yank the reader
      // to a scrollTop derived from an unrelated prior scrollHeight.
      if (nextCount > prevCount) {
        const delta = el.scrollHeight - pendingOlderAnchorRef.current
        el.scrollTop = el.scrollTop + delta
      }
      pendingOlderAnchorRef.current = null
      return
    }

    if (!didInitialTailScrollRef.current) return
    const nearTail = el.scrollHeight - (el.scrollTop + el.clientHeight) < 80
    if (nextCount > prevCount && nearTail) {
      el.scrollTop = el.scrollHeight
    }
  }, [chronological.length])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="bot-activity-modal"
        showCloseButton={false}
        className="flex h-[72vh] max-h-170 w-full max-w-2xl flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
      >
        <header className="flex shrink-0 items-center gap-3 border-b border-border/40 px-4 py-3">
          <AgentAvatar name={bot?.name ?? ""} avatarUrl={bot?.image ?? null} seed={bot?.id} size={32} />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <DialogTitle className="truncate text-sm font-medium">
              {bot?.name ?? "Bot"}
            </DialogTitle>
            <DialogDescription className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
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
            </DialogDescription>
          </div>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            Close
          </button>
        </header>

        <div ref={scrollRef} className="flex-1 overflow-y-auto thin-scrollbar bg-background">
          {isLoading && chronological.length === 0 ? (
            <SkeletonRows />
          ) : chronological.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="pb-3">
              {hasNextPage ? (
                <div className="flex justify-center py-2">
                  <button
                    type="button"
                    onClick={onLoadOlder}
                    disabled={isFetchingNextPage}
                    className="rounded-md px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70 hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isFetchingNextPage ? "Loading older" : "Load older"}
                  </button>
                </div>
              ) : (
                <div className="py-2 text-center font-mono text-[10px] uppercase tracking-wider text-muted-foreground/40">
                  Beginning of log
                </div>
              )}
              {grouped.map((group) => (
                <section key={group.dayKey}>
                  <DayDivider label={group.label} />
                  {group.events.map((event) => (
                    <BotActivityRow key={event.id} event={event} />
                  ))}
                </section>
              ))}
              <div ref={bottomAnchorRef} aria-hidden />
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function DayDivider({ label }: { label: string }) {
  return (
    <div className="sticky top-0 z-10 border-b border-border/40 bg-background/95 px-4 py-1 backdrop-blur supports-backdrop-filter:bg-background/80">
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

type DayGroup = { dayKey: string; label: string; events: AuditEvent[] }

function groupByDay(events: AuditEvent[]): DayGroup[] {
  const groups: DayGroup[] = []
  for (const event of events) {
    const key = dayKey(event.createdAt)
    const tail = groups[groups.length - 1]
    if (tail && tail.dayKey === key) {
      tail.events.push(event)
    } else {
      groups.push({ dayKey: key, label: formatDayLabel(event.createdAt), events: [event] })
    }
  }
  return groups
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
