"use client"

import { useAtom, useCreateAtom } from "@tanstack/react-store";


import { AuditLogTextPayloadSchema } from "@alook/shared"
import { CircleStop, LoaderCircle, Lock, Square } from "lucide-react"
import { useEffect, useId, useLayoutEffect, useRef } from "react"
import { useBotAuditPreview } from "@/hooks/community/use-bot-audit-preview"
import { useBotMarks } from "@/hooks/community/use-bot-marks"
import { formatRelativeTime } from "@/lib/community/format-time"
import { tid } from "@/lib/community/testids"
import { Avatar } from "../avatar"
import { MessageBody } from "../messages/message-body"
import { MessageAuthorLine } from "../messages/message-author-line"
import { BotAuditActiveRow } from "./bot-audit-preview"
import styles from "./bot-mark-sticker.module.css"

const VISIBLE_MARKS = 3
type StickerView = "thoughts" | "marks"

function NotebookBinding({ front }: { front: boolean }) {
  const patternId = useId()
  return (
    <svg aria-hidden className={styles.binding}>
      <defs>
        <pattern id={patternId} x="-6" width="36" height="48" patternUnits="userSpaceOnUse">
          <g transform="translate(6 24)">
            {front ? <>
              <ellipse cx="23" cy="2.34" rx="3.5" ry="2.5" className={styles.hole} />
              <path d="M23 2.34C24.44-1.75 19.78-6.12 12.6-7.41C5.42-8.7-1.56-6.43-3-2.34" className={styles.wire} />
            </> : (
              <path d="M-3-2.34C-4.44 1.75 .22 6.12 7.4 7.41C14.58 8.7 21.56 6.43 23 2.34" className={styles.wire} />
            )}
          </g>
        </pattern>
      </defs>
      <rect x="-6" width="36" height="100%" fill={`url(#${patternId})`} />
    </svg>
  )
}

type BotMarkStickerProps = {
  botId: string
  active: boolean
  showStop: boolean
  stopPending: boolean
  onStop: () => void
  onOpenActivity: () => void
}

export function BotMarkSticker(props: BotMarkStickerProps) {
  const activity = useBotAuditPreview(props.botId, true)
  const { marks, isLoading, isError } = useBotMarks(props.botId)
  return <BotMarkStickerView {...props} activity={activity} marks={marks} isLoading={isLoading} isError={isError} />
}

export function BotMarkStickerView({
  active, showStop, stopPending, onStop, onOpenActivity, activity, marks, isLoading, isError,
}: Omit<BotMarkStickerProps, "botId" | "onOpenActivity"> & {
  onOpenActivity?: () => void
  activity: Pick<ReturnType<typeof useBotAuditPreview>, "events" | "isLoading" | "isError" | "isNotFound">
  marks: ReturnType<typeof useBotMarks>["marks"]
  isLoading: boolean
  isError: boolean
}) {
  const [view, setView] = useAtom(useCreateAtom<StickerView>("thoughts"))
  const activityScrollRef = useRef<HTMLDivElement>(null)
  const latestEventIdRef = useRef<string | undefined>(undefined)
  const didInitialTailScrollRef = useRef(false)
  const nearTailRef = useRef(true)
  const ThoughtTime = onOpenActivity ? "button" : "div"
  const visibleMarks = marks.slice(0, VISIBLE_MARKS)
  const hasOverflow = marks.length > VISIBLE_MARKS
  const visibleEvents = [...activity.events]
    .sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt ? -1 : 1
      return a.id > b.id ? -1 : a.id < b.id ? 1 : 0
    })
    .slice(0, 10)
    .reverse()
  const latestVisibleEventId = visibleEvents.at(-1)?.id

  useEffect(() => {
    if (view === "thoughts") return
    didInitialTailScrollRef.current = false
    latestEventIdRef.current = undefined
  }, [view])

  useEffect(() => {
    if (view !== "thoughts") return
    if (didInitialTailScrollRef.current) return
    if (visibleEvents.length === 0) return
    const scroller = activityScrollRef.current
    if (!scroller) return
    let secondFrame = 0
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        scroller.scrollTop = scroller.scrollHeight
        latestEventIdRef.current = latestVisibleEventId
        didInitialTailScrollRef.current = true
        nearTailRef.current = true
      })
    })
    return () => {
      cancelAnimationFrame(firstFrame)
      if (secondFrame) cancelAnimationFrame(secondFrame)
    }
  }, [activity.isLoading, latestVisibleEventId, view, visibleEvents.length])

  useLayoutEffect(() => {
    const previousLatestEventId = latestEventIdRef.current
    latestEventIdRef.current = latestVisibleEventId
    if (view !== "thoughts") return
    if (!didInitialTailScrollRef.current) return
    if (!latestVisibleEventId || latestVisibleEventId === previousLatestEventId) return
    const scroller = activityScrollRef.current
    if (!scroller) return
    if (nearTailRef.current) scroller.scrollTop = scroller.scrollHeight
  }, [latestVisibleEventId, view])

  if (activity.isNotFound) return null

  return (
    <section data-testid={tid.botMarkSticker} aria-label="Bot log" className={styles.notebook}>
      <NotebookBinding front={false} />
      <div aria-hidden className={styles.stack} />
      <div aria-hidden className={styles.paper} />
      <NotebookBinding front />
      <div className={styles.content}>
      <header className={`${styles.header} flex shrink-0 items-center gap-2`}>
        <span className="font-brand text-[34px] font-bold leading-none">Bot log</span>
        <span className="ml-auto flex items-center gap-1 whitespace-nowrap text-[10px]" style={{ color: "var(--note-muted)" }}>
          <Lock className="size-3" aria-hidden />Only you
        </span>
      </header>
      <div role="tablist" aria-label="Bot log view" className={styles.tabs}>
        {(["thoughts", "marks"] as const).map((tab) => (
          <button key={tab} type="button" role="tab" aria-label={tab === "thoughts" ? "Thoughts" : "Marked messages"}
            aria-selected={view === tab} onClick={() => setView(tab)} className={styles.tab}>
            <span className={styles.tabLabel}>{tab === "thoughts" ? "Thoughts" : "Marks"}</span>
            {tab === "marks" && marks.length > 0 && (
              <span data-testid={hasOverflow ? tid.botMarkStickerOverflow : undefined} role={hasOverflow ? "status" : undefined} className="text-[10px] tabular-nums">
                {hasOverflow && <span className="sr-only">More marked work</span>}{hasOverflow ? "3+" : marks.length}
              </span>
            )}
          </button>
        ))}
      </div>
      {view === "thoughts" ? (
        <div role="tabpanel" aria-label="Recent thoughts" className="flex min-h-0 flex-1 flex-col pt-2">
          <div ref={activityScrollRef} data-testid={tid.botAuditPreviewScroll}
            onScroll={({ currentTarget }) => {
              nearTailRef.current = currentTarget.scrollHeight - (currentTarget.scrollTop + currentTarget.clientHeight) < 80
            }}
            className={`thin-scrollbar ${styles.scrollbar} min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain`}>
            <div data-testid={tid.botAuditPreviewBottom} className={`flex min-h-full flex-col ${!activity.isLoading && (activity.isError || visibleEvents.length === 0) ? "justify-center" : "justify-end"}`}>
              {activity.isLoading ? <ThoughtsLoading /> : activity.isError ? <StickerState label="Thoughts unavailable" /> : visibleEvents.length === 0 ? <StickerState label="No recent thoughts" /> : visibleEvents.map((event) => {
                const parsed = AuditLogTextPayloadSchema.safeParse(event.payload)
                return <div key={event.id} data-testid={tid.botAuditPreviewRow(event.id)} className={styles.entry}>
                  <ThoughtTime onClick={onOpenActivity} title={onOpenActivity ? "Open full audit log" : undefined}
                    className={styles.thoughtTime}>
                    <time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time>
                  </ThoughtTime>
                  <div className={styles.thought} style={onOpenActivity ? undefined : { cursor: "text" }} onClick={onOpenActivity ? (event) => {
                    if (event.defaultPrevented || (event.target instanceof Element &&
                      event.target.closest("a, button, input, select, textarea, summary, [role='button']"))) return
                    if (window.getSelection()?.toString()) return
                    onOpenActivity()
                  } : undefined}>
                    <MessageBody text={parsed.success ? `${parsed.data.text}${parsed.data.truncated ? "…" : ""}` : "Text unavailable"} />
                  </div>
                </div>
              })}
            </div>
          </div>
        </div>
      ) : (
        <div role="tabpanel" className={`thin-scrollbar ${styles.scrollbar} mt-2 min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1`}>
          {isLoading ? (
            <StickerState label="Loading marked messages" />
          ) : isError ? (
            <StickerState label="Marked messages unavailable" />
          ) : visibleMarks.length === 0 ? (
            <StickerState label="No marked messages" />
          ) : (
            <div className="space-y-1 py-1">
              {visibleMarks.map((mark) => {
                const locationPrefix = mark.serverId ? mark.server : "DM"
                const normalizedLocationChannel = mark.channel.trim()
                const rawLocationChannel = !mark.serverId
                  && normalizedLocationChannel.toLowerCase() === "unknown"
                  ? ""
                  : normalizedLocationChannel
                const locationChannel = rawLocationChannel
                  ? (mark.serverId ? `#${rawLocationChannel}` : rawLocationChannel)
                  : ""
                const location = locationChannel
                  ? `${locationPrefix} · ${locationChannel}`
                  : locationPrefix
                const content = mark.m.content?.trim() ? mark.m.content : "Empty message"
                return (
                  <div
                    key={mark.id}
                    data-testid={tid.botMarkStickerRow(mark.id)}
                    className="grid min-h-20 grid-cols-[0.875rem_minmax(0,1fr)] items-start gap-2 rounded-xl px-2 py-2 transition-colors hover:bg-accent/30"
                  >
                    <Square className="mt-1.5 size-3.5 shrink-0 text-(--note-muted)" strokeWidth={1.75} aria-hidden />
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-start gap-2">
                        <Avatar
                          label={mark.m.authorAvatar || mark.m.authorName || "?"}
                          seed={mark.m.authorId}
                          size={28}
                        />
                        <div className="w-fit min-w-0 max-w-full">
                          <MessageAuthorLine
                            variant="note"
                            authorName={mark.m.authorName || "Deleted user"}
                            timestamp={mark.m.createdAt ? formatRelativeTime(mark.m.createdAt) : undefined}
                            timestampProps={{ dateTime: mark.m.createdAt }}
                          />
                          <div title={location} className="flex w-fit min-w-0 max-w-full items-center gap-1 text-[10px] leading-4 text-(--note-muted)">
                            <span className={mark.serverId ? "min-w-0 truncate" : "shrink-0"}>
                              {locationPrefix}
                            </span>
                            {locationChannel && (
                              <>
                                <span className="shrink-0" aria-hidden>·</span>
                                <span className="min-w-0 truncate">{locationChannel}</span>
                              </>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className={styles.markedBody}>
                        <MessageBody text={content} />
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      <footer className={styles.footer}>
        <div className="min-w-0 flex-1 overflow-hidden">
          {active ? <BotAuditActiveRow showTime={false} /> : <span className="text-xs text-(--note-muted)">Ready when you are</span>}
        </div>
        {showStop && <button type="button" data-testid={tid.botMarkStickerStop} onClick={onStop} disabled={stopPending}
          aria-label={stopPending ? "Stopping current agent turn" : "Stop current agent turn"} className={styles.stop}>
          {stopPending ? <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden /> : <CircleStop className="size-3.5" aria-hidden />}
          <span className={styles.stopLabel}>{stopPending ? "Stopping…" : "Stop"}</span>
        </button>}
      </footer>
      </div>
    </section>
  )
}

function ThoughtsLoading() {
  return (
    <div role="status" aria-label="Loading thoughts" className={styles.loading}>
      <span className="sr-only">Loading thoughts</span>
      <div aria-hidden="true" className={styles.loadingEntries}>
        {[0, 1].map((entry) => (
          <div key={entry} className={styles.loadingEntry}>
            <span className={styles.loadingTime} />
            <span className={styles.loadingLine} />
            <span className={styles.loadingLine} />
            <span className={styles.loadingLine} />
          </div>
        ))}
      </div>
    </div>
  )
}

function StickerState({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center px-4 text-xs text-(--note-muted)">
      {label}
    </div>
  )
}
