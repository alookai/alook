"use client"

/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V4 */

import {
  BOT_ACTIVITY_PRESETS,
  RUNNING_PRESETS,
} from "@alook/shared"
import { Activity, ChevronRight, Lock } from "lucide-react"
import { useEffect, useState } from "react"
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
    || isBotActivityRunning(emoji, text)
}

export function isBotActivityRunning(
  emoji: string | null | undefined,
  text: string | null | undefined,
): boolean {
  return RUNNING_PRESETS.some((pair) => matchesStatus(emoji, text, pair))
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

  const visibleEvents = [...events]
    .sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt ? -1 : 1
      return a.id > b.id ? -1 : a.id < b.id ? 1 : 0
    })
    .slice(0, active ? 4 : 5)
    .reverse()

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
        "relative flex w-full shrink-0 flex-col overflow-hidden rounded-xl border bg-card text-left shadow-(--e1) transition-[border-color] duration-150",
        "after:pointer-events-none after:absolute after:inset-0 after:z-10 after:rounded-[inherit] after:opacity-0 after:ring-2 after:ring-inset after:ring-ring/50 after:transition-opacity after:duration-150 after:content-[''] hover:after:opacity-100 active:after:ring-ring/70",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        active
          ? "bot-audit-active-heartbeat border-primary/35 before:pointer-events-none before:absolute before:inset-0 before:z-20 before:rounded-[inherit] before:ring-2 before:ring-inset before:ring-primary/60 before:content-['']"
          : "border-border",
      ].join(" ")}
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/40 px-3">
        <Activity className="size-3.5 text-muted-foreground" aria-hidden />
        <span className="shrink-0 text-xs font-medium text-foreground">Recent activity</span>
        <span className="ml-auto flex shrink-0 items-center gap-1 whitespace-nowrap text-[10px] text-muted-foreground">
          <Lock className="size-3" aria-hidden />
          Only you can see this
        </span>
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      </div>
      <div className="flex flex-col py-1">
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
        {active && <ActiveRow latestEventAt={visibleEvents.at(-1)?.createdAt} />}
      </div>
    </button>
  )
}

function ActiveRow({ latestEventAt }: { latestEventAt?: string }) {
  const [nowMs, setNowMs] = useState(Date.now)

  useEffect(() => {
    let timer: ReturnType<typeof globalThis.setTimeout>
    const scheduleNextMinute = () => {
      const delay = 60_000 - (Date.now() % 60_000)
      timer = globalThis.setTimeout(() => {
        setNowMs(Date.now())
        scheduleNextMinute()
      }, delay)
    }
    scheduleNextMinute()
    return () => globalThis.clearTimeout(timer)
  }, [])

  const latestEventMs = latestEventAt ? Date.parse(latestEventAt) : Number.NaN
  const displayedAt = new Date(
    Number.isFinite(latestEventMs) ? Math.max(nowMs, latestEventMs) : nowMs,
  ).toISOString()

  return (
    <div
      data-testid={tid.botAuditPreviewActive}
      className="grid h-6 shrink-0 grid-cols-[3.25rem_minmax(0,1fr)] items-center gap-2 px-3 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1 motion-safe:duration-200 motion-reduce:animate-none"
    >
      <time
        dateTime={displayedAt}
        suppressHydrationWarning
        className="font-mono text-[10px] tabular-nums text-muted-foreground/70"
      >
        {formatAuditPreviewTime(displayedAt)}
      </time>
      <span className="flex items-center gap-1" aria-label="Bot activity in progress">
        <span className="mr-1 text-xs text-primary/70">running</span>
        {[0, 1, 2].map((index) => (
          <span
            key={index}
            aria-hidden
            className="size-1.5 rounded-full bg-primary motion-safe:animate-pulse motion-reduce:animate-none"
            style={{ animationDelay: `${index * 160}ms` }}
          />
        ))}
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
