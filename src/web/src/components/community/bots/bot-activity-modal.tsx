"use client"

import { useEffect, useLayoutEffect, useMemo, useRef } from "react"
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
 *   - oldest at the top, newest at the bottom;
 *   - auto-scrolls to the tail on open and on new live rows (only when the
 *     user was already near the tail — a reader scrolled up to inspect
 *     history is not yanked back);
 *   - scroll UP to load the next (older) page; the scroll offset is
 *     preserved across the prepend so the row under the eye stays fixed.
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

  // The API returns newest-first (createdAt DESC). The UI wants
  // oldest-first at the top so the log reads chronologically — flip once here.
  const chronological = useMemo(() => [...events].reverse(), [events])

  // Chronologically-adjacent rows are grouped under a shared day header,
  // rendered when the day boundary changes. Cheap to compute at the render
  // scale we operate at (500-row cap per bot).
  const grouped = useMemo(() => groupByDay(chronological), [chronological])

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const lastCountRef = useRef(0)
  const pendingOlderAnchorRef = useRef<number | null>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (!el || !hasNextPage) return
    const onScroll = () => {
      if (isFetchingNextPage) return
      if (el.scrollTop < 80) {
        pendingOlderAnchorRef.current = el.scrollHeight
        void fetchNextPage()
      }
    }
    el.addEventListener("scroll", onScroll)
    return () => el.removeEventListener("scroll", onScroll)
  }, [fetchNextPage, hasNextPage, isFetchingNextPage])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const prevCount = lastCountRef.current
    const nextCount = chronological.length
    lastCountRef.current = nextCount
    if (nextCount === 0) return

    if (pendingOlderAnchorRef.current !== null) {
      const delta = el.scrollHeight - pendingOlderAnchorRef.current
      el.scrollTop = el.scrollTop + delta
      pendingOlderAnchorRef.current = null
      return
    }

    const nearTail = el.scrollHeight - (el.scrollTop + el.clientHeight) < 80
    const firstPaint = prevCount === 0
    if (firstPaint || (nextCount > prevCount && nearTail)) {
      el.scrollTop = el.scrollHeight
    }
  }, [chronological.length])

  useEffect(() => {
    if (!open) {
      lastCountRef.current = 0
      pendingOlderAnchorRef.current = null
    }
  }, [open, bot?.id])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[72vh] max-h-170 w-full max-w-2xl flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
      >
        <header className="flex shrink-0 items-center gap-3 border-b border-border/40 px-4 py-3">
          <AgentAvatar name={bot?.name ?? ""} avatarUrl={bot?.image ?? null} size={32} />
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
              {isFetchingNextPage ? (
                <div className="py-2 text-center font-mono text-[10px] uppercase tracking-wider text-muted-foreground/60">
                  Loading older
                </div>
              ) : hasNextPage ? (
                <div className="py-2 text-center font-mono text-[10px] uppercase tracking-wider text-muted-foreground/40">
                  Scroll up for older
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
