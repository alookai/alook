"use client"

/* Hallmark · component: secondary-card · genre: playful · theme: Alook locked system
 * states: default · hover · focus · active · disabled · loading · error · success
 * contrast: verified in light and dark browser QA
 */

import { stripInlineMarkup } from "@alook/shared"
import { Activity, ChevronRight, CircleStop, ListTodo, LoaderCircle, Lock, Square } from "lucide-react"
import { useState } from "react"
import { useBotAuditPreview } from "@/hooks/community/use-bot-audit-preview"
import { useBotMarks } from "@/hooks/community/use-bot-marks"
import { formatRelativeTime } from "@/lib/community/format-time"
import { tid } from "@/lib/community/testids"
import { Avatar } from "../avatar"
import { BotAuditActiveRow, BotAuditTimeline } from "./bot-audit-preview"

const VISIBLE_MARKS = 3
type StickerView = "activity" | "marks"

function stickerTabClass(selected: boolean): string {
  return [
    "flex h-8 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-[10px] px-2 text-xs font-medium text-[#74613a] hover:text-[#342a18] active:bg-[#dfb95d] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:outline-none dark:text-[#65501f] dark:active:bg-[#b18432]",
    selected
      ? "bg-[#dfb75b] text-[#342a18] shadow-[inset_0_2px_4px_rgba(91,60,10,0.2),inset_0_-1px_0_#f3d989] dark:bg-[#b2822a]"
      : "",
  ].join(" ")
}

export function BotMarkSticker({
  botId,
  active,
  showStop,
  stopPending,
  onStop,
  onOpenActivity,
}: {
  botId: string
  active: boolean
  showStop: boolean
  stopPending: boolean
  onStop: () => void
  onOpenActivity: () => void
}) {
  const [view, setView] = useState<StickerView>("activity")
  const activity = useBotAuditPreview(botId)
  const { marks, isLoading, isError } = useBotMarks(botId)
  const visibleMarks = marks.slice(0, VISIBLE_MARKS)
  const hasOverflow = marks.length > VISIBLE_MARKS
  const visibleEvents = [...activity.events]
    .sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt ? -1 : 1
      return a.id > b.id ? -1 : a.id < b.id ? 1 : 0
    })
    .slice(0, active ? 4 : 5)
    .reverse()

  return (
    <section
      data-testid={tid.botMarkSticker}
      aria-label="Bot work note"
      className="relative flex h-84 min-h-0 w-full flex-col overflow-hidden rounded-2xl border border-[#d3aa4c] bg-[#f6dc92] text-[#342a18] shadow-[0_16px_34px_rgba(76,54,15,0.18),3px_3px_0_#d5ac50,inset_0_1px_0_rgba(255,255,255,0.72)] sm:h-full dark:border-[#a77b26] dark:bg-[#d2a64b] dark:shadow-[0_18px_38px_rgba(0,0,0,0.38),3px_3px_0_#946b20,inset_0_1px_0_rgba(255,244,194,0.5)]"
    >
      <header className="flex shrink-0 items-center gap-2 px-4 pb-2 pt-3">
        <span className="font-brand text-2xl font-semibold leading-none tracking-wide">Bot note</span>
        <span className="ml-auto flex items-center gap-1 whitespace-nowrap text-[10px] text-[#74613a] dark:text-[#65501f]">
          <Lock className="size-3" aria-hidden />
          Only you
        </span>
      </header>

      <div role="tablist" aria-label="Bot note view" className="mx-3 mb-1 flex h-9 shrink-0 items-center gap-1 rounded-xl bg-[#e8c56f] p-0.5 shadow-[inset_0_1px_3px_rgba(98,67,11,0.14)] dark:bg-[#bd913b]">
        <button
          type="button"
          role="tab"
          aria-label="Recent activity"
          aria-selected={view === "activity"}
          onClick={() => setView("activity")}
          className={stickerTabClass(view === "activity")}
        >
          <Activity className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">Activity</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-label="Marked messages"
          aria-selected={view === "marks"}
          onClick={() => setView("marks")}
          className={stickerTabClass(view === "marks")}
        >
          <ListTodo className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">Marks</span>
          {marks.length > 0 && (
            <span
              data-testid={hasOverflow ? tid.botMarkStickerOverflow : undefined}
              role={hasOverflow ? "status" : undefined}
              className="font-mono text-[10px] tabular-nums"
            >
              {hasOverflow && <span className="sr-only">More marked work</span>}
              {hasOverflow ? "3+" : marks.length}
            </span>
          )}
        </button>
      </div>

      {view === "activity" ? (
        <button
          type="button"
          onClick={onOpenActivity}
          aria-label={active
            ? "Bot activity in progress. Open full bot activity log"
            : "Bot at rest. Open full bot activity log"}
          className="thin-scrollbar group relative mx-3 mb-1 flex min-h-0 flex-1 flex-col overflow-y-auto rounded-xl px-1 py-2 text-left transition-colors hover:bg-[#f9e7ad] active:bg-[#efd080] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:outline-none dark:hover:bg-[#dcba63] dark:active:bg-[#c99b3d]"
        >
          <span className="pointer-events-none absolute right-2 top-2 grid size-6 place-items-center rounded-lg text-[#74613a] opacity-0 transition-opacity group-hover:opacity-100" aria-hidden>
            <ChevronRight className="size-3.5" />
          </span>
          <div className="flex min-h-0 flex-1 flex-col justify-start pr-5">
            <BotAuditTimeline
              events={visibleEvents}
              isLoading={activity.isLoading}
              isError={activity.isError || activity.isNotFound}
              active={false}
            />
          </div>
        </button>
      ) : (
        <div role="tabpanel" className="thin-scrollbar mx-3 mb-1 min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1">
          {isLoading ? (
            <StickerState label="Loading marked messages" />
          ) : isError ? (
            <StickerState label="Marked messages unavailable" />
          ) : visibleMarks.length === 0 ? (
            <StickerState label="No marked messages" />
          ) : (
            <div className="space-y-1 py-1">
              {visibleMarks.map((mark) => {
                const location = mark.serverId
                  ? `${mark.server} · #${mark.channel}`
                  : `DM · ${mark.channel}`
                const content = stripInlineMarkup(mark.m.content ?? "").trim() || "Empty message"
                return (
                  <div
                    key={mark.id}
                    data-testid={tid.botMarkStickerRow(mark.id)}
                    className="grid min-h-20 grid-cols-[0.875rem_minmax(0,1fr)] items-start gap-2 rounded-xl px-2 py-2 transition-colors hover:bg-[#f9e7ad] dark:hover:bg-[#dcba63]"
                  >
                    <Square className="mt-1.5 size-3.5 shrink-0 text-[#9a741f]" strokeWidth={1.75} aria-hidden />
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-start gap-2">
                        <Avatar
                          label={mark.m.authorAvatar || mark.m.authorName || "?"}
                          seed={mark.m.authorId}
                          size={28}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-center gap-2 text-xs leading-4">
                            <span className="min-w-0 flex-1 truncate font-semibold">
                              {mark.m.authorName || "Unknown"}
                            </span>
                            {mark.m.createdAt && (
                              <time dateTime={mark.m.createdAt} className="shrink-0 whitespace-nowrap font-mono text-[9px] tabular-nums text-[#74613a]">
                                {formatRelativeTime(mark.m.createdAt)}
                              </time>
                            )}
                          </div>
                          <div title={location} className="truncate text-[10px] leading-4 text-[#74613a]">
                            {location}
                          </div>
                        </div>
                      </div>
                      <p className="mt-1 line-clamp-2 text-sm leading-5">
                        {content}
                      </p>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      <footer className="flex h-11 shrink-0 items-center gap-1 px-3 pb-2 pt-1">
        {active ? (
          <div className="min-w-0 flex-1 overflow-hidden">
            <BotAuditActiveRow latestEventAt={visibleEvents.at(-1)?.createdAt} />
          </div>
        ) : (
          <span className="min-w-0 flex-1 truncate px-1 font-brand text-base text-[#74613a]">Ready when you are</span>
        )}
        {showStop && (
          <button
            type="button"
            data-testid={tid.botMarkStickerStop}
            onClick={onStop}
            disabled={stopPending}
            aria-label={stopPending ? "Stopping current agent turn" : "Stop current agent turn"}
            className="flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-sm px-2 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10 active:bg-destructive/20 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-wait disabled:bg-destructive/5 disabled:text-destructive/70"
          >
            {stopPending
              ? <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />
              : <CircleStop className="size-4" aria-hidden />}
            {stopPending ? "Stopping…" : "Stop"}
          </button>
        )}
      </footer>
    </section>
  )
}

function StickerState({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center px-4 text-xs text-muted-foreground">
      {label}
    </div>
  )
}
