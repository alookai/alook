"use client"

import {
  BOT_ACTIVITY_PRESETS,
  RUNNING_PRESETS,
} from "@alook/shared"
import { Activity, ChevronRight } from "lucide-react"
import { useBotAuditPreview } from "@/hooks/community/use-bot-audit-preview"
import {
  formatAuditPreviewTime,
  summarizeAuditEvent,
} from "@/lib/community/audit-event-summary"
import { tid } from "@/lib/community/testids"

type StatusPair = { emoji: string; text: string }

function matchesStatus(
  emoji: string | null | undefined,
  text: string | null | undefined,
  pair: StatusPair,
): boolean {
  return emoji === pair.emoji && text === pair.text
}

export function isBotActivityActive(
  emoji: string | null | undefined,
  text: string | null | undefined,
): boolean {
  return matchesStatus(emoji, text, BOT_ACTIVITY_PRESETS.starting)
    || matchesStatus(emoji, text, BOT_ACTIVITY_PRESETS.stopping)
    || RUNNING_PRESETS.some((pair) => matchesStatus(emoji, text, pair))
}

export function BotAuditPreview({
  botId,
  active,
  onOpen,
}: {
  botId: string
  active: boolean
  onOpen: () => void
}) {
  const { events, isLoading, isError, isNotFound } = useBotAuditPreview(botId)

  if (isNotFound) return null

  const visibleEvents = active ? events.slice(0, 4) : events.slice(0, 5)

  return (
    <button
      type="button"
      data-testid={tid.botAuditPreview}
      data-active={active || undefined}
      onClick={onOpen}
      aria-label={active
        ? "Bot activity in progress. Open full bot activity log"
        : "Bot at rest. Open full bot activity log"}
      className={[
        "flex h-40 w-full shrink-0 flex-col overflow-hidden rounded-xl border bg-card text-left shadow-(--e1) transition-colors duration-150 hover:bg-accent/40 active:bg-accent/60",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        active ? "border-primary/35" : "border-border",
      ].join(" ")}
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/40 px-3">
        <Activity className="size-3.5 text-muted-foreground" aria-hidden />
        <span className="text-xs font-medium text-foreground">Recent activity</span>
        <ChevronRight className="ml-auto size-3.5 text-muted-foreground" aria-hidden />
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto py-1 thin-scrollbar">
        {active && <ActiveRow />}
        {isLoading ? (
          <PreviewSkeleton />
        ) : isError ? (
          <PreviewStateRow label="Activity unavailable" />
        ) : visibleEvents.length > 0 ? (
          visibleEvents.map((event) => (
            <div
              key={event.id}
              data-testid={tid.botAuditPreviewRow(event.id)}
              className="grid h-6 grid-cols-[3.25rem_minmax(0,1fr)] items-center gap-2 px-3 text-xs"
            >
              <time
                dateTime={event.createdAt}
                className="font-mono text-[10px] tabular-nums text-muted-foreground/70"
              >
                {formatAuditPreviewTime(event.createdAt)}
              </time>
              <span className="truncate text-muted-foreground">
                {summarizeAuditEvent(event)}
              </span>
            </div>
          ))
        ) : (
          <PreviewStateRow label="No recent activity" />
        )}
      </div>
    </button>
  )
}

function ActiveRow() {
  return (
    <div
      data-testid={tid.botAuditPreviewActive}
      className="grid h-6 grid-cols-[3.25rem_minmax(0,1fr)] items-center gap-2 px-3"
    >
      <span className="font-mono text-[10px] uppercase tracking-wide text-primary/70">
        now
      </span>
      <span className="flex items-center gap-1" aria-label="Bot activity in progress">
        {[0, 1, 2].map((index) => (
          <span
            key={index}
            aria-hidden
            className="size-1.5 rounded-full bg-primary motion-safe:animate-bounce motion-reduce:animate-none"
            style={{ animationDelay: `${index * 120}ms` }}
          />
        ))}
        <span
          aria-hidden
          className="ml-1 h-px flex-1 bg-linear-to-r from-primary/55 via-primary/20 to-transparent motion-safe:animate-pulse motion-reduce:animate-none"
        />
      </span>
    </div>
  )
}

function PreviewSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1 px-3 py-1" aria-label="Loading recent activity">
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className="flex h-5 items-center gap-2">
          <span className="h-2 w-10 animate-pulse rounded bg-muted motion-reduce:animate-none" />
          <span className="h-2 flex-1 animate-pulse rounded bg-muted motion-reduce:animate-none" />
        </div>
      ))}
    </div>
  )
}

function PreviewStateRow({ label }: { label: string }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-xs text-muted-foreground">
      {label}
    </div>
  )
}
