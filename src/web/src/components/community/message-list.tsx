"use client"

import { useEffect, useRef, useState } from "react"
import { DateDivider, NewDivider } from "./dividers"
import { Message } from "./message"
import { TypingIndicator } from "./typing-indicator"
import { dateKey, formatDateLabel } from "./format-time"
import { ChannelIcon } from "./channel-icon"
import { Skeleton } from "@/components/ui/skeleton"
import type { Msg, OpenProfile } from "./_types"

// Channel message list — welcome hero, date dividers, messages (with the NEW divider),
// and typing indicator. Data via props.
export function MessageList({
  channel, messages, loading, pinnedIds, newDividerBefore, typingUsers, onOpenThread, onOpenProfile,
  onToggleReaction, onReact,
  onReply, onPin, onCreateThread, onCopy, onRetry, onPreviewImage, onDownloadFile,
  resolveUserName, scrollToMessageId, hero,
}: {
  channel: string
  messages: Msg[]
  loading?: boolean
  pinnedIds?: Set<string>
  newDividerBefore?: string
  typingUsers?: string[]
  onOpenThread: (id: string) => void
  onOpenProfile?: OpenProfile
  onToggleReaction?: (id: string, emoji: string) => void
  onReact?: (id: string, emoji: string) => void
  onReply?: (id: string) => void
  onPin?: (id: string) => void
  onCreateThread?: (id: string) => void
  onCopy?: (id: string) => void
  onRetry?: (id: string) => void
  onPreviewImage?: (name: string) => void
  onDownloadFile?: (name: string) => void
  resolveUserName?: (userId: string) => string
  scrollToMessageId?: string | null
  hero?: React.ReactNode
}) {
  const [jumped, setJumped] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const prevMsgCountRef = useRef(messages.length)

  // When the messages list is cleared on channel switch, the previous count is
  // stale — the very first batch that arrives would compare against the old
  // length and skip the bottom-anchor scroll. Reset when we hit empty.
  useEffect(() => {
    if (messages.length === 0) prevMsgCountRef.current = 0
  }, [messages.length])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    // Scroll to bottom on initial load or when new messages arrive
    const isNewMessage = messages.length > prevMsgCountRef.current
    prevMsgCountRef.current = messages.length
    // Only auto-scroll if user is near the bottom (within 150px) or it's initial/new message
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 150
    if (nearBottom || isNewMessage) {
      el.scrollTop = el.scrollHeight
    }
  }, [messages])

  const jumpTo = (id: string) => {
    setJumped(id)
    document.getElementById(`dpv-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" })
    window.setTimeout(() => setJumped((v) => (v === id ? null : v)), 1600)
  }

  useEffect(() => {
    if (scrollToMessageId) jumpTo(scrollToMessageId)
  }, [scrollToMessageId])

  // All hooks must run before any conditional return — rule-of-hooks.
  if (loading && messages.length === 0) return <MessageListSkeleton dm={!!hero} />

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} className="flex-1 overflow-y-auto thin-scrollbar">
        <div className="flex min-h-full flex-col justify-end px-4 py-8">
          <div className="mb-6">
            {hero ?? (
              <>
                <div className="mb-2 grid size-12 place-items-center rounded-full bg-muted/60">
                  <ChannelIcon className="text-xl text-muted-foreground" />
                </div>
                <h2 className="text-xl font-semibold leading-tight">{channel}</h2>
                <p className="mt-2 text-sm text-muted-foreground">Beginning of the channel. Say hello, share what you&apos;re working on, or drop a link.</p>
              </>
            )}
          </div>

          {(() => {
            // Group consecutive messages from same author into clusters
            const clusters: { messages: { m: Msg; grouped: boolean; showDateDivider: boolean; showNewDivider: boolean }[] }[] = []
            messages.forEach((m, i) => {
              const prev = i > 0 ? messages[i - 1] : null
              const prevDate = prev ? dateKey(prev.createdAt) : ""
              const curDate = dateKey(m.createdAt)
              const showDateDivider = !!(curDate && curDate !== prevDate)
              const grouped = !!(prev && !m.type && !m.replyTo && !showDateDivider && prev.authorName === m.authorName
                && prev.createdAt && m.createdAt && (new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime()) < 420_000)
              const entry = { m, grouped, showDateDivider, showNewDivider: m.id === newDividerBefore }
              if (grouped && clusters.length > 0) {
                clusters[clusters.length - 1].messages.push(entry)
              } else {
                clusters.push({ messages: [entry] })
              }
            })
            return clusters.map((cluster, ci) => (
              <div key={cluster.messages[0].m.id ?? ci}>
                {cluster.messages.map(({ m, grouped, showDateDivider, showNewDivider }) => (
                  <div key={m.id}>
                    {showDateDivider && <DateDivider label={formatDateLabel(m.createdAt!)} />}
                    {showNewDivider && <NewDivider />}
                    <Message
                      m={{ ...m, grouped }}
                      pinned={pinnedIds?.has(m.id)}
                      onOpenThread={onOpenThread}
                      onOpenProfile={onOpenProfile}
                      onJumpReply={() => m.replyTo && jumpTo(m.replyTo.id)}
                      onToggleReaction={onToggleReaction ? (emoji) => onToggleReaction(m.id, emoji) : undefined}
                      onReact={onReact ? (emoji) => onReact(m.id, emoji) : undefined}
                      onReply={onReply ? () => onReply(m.id) : undefined}
                      onPin={onPin ? () => onPin(m.id) : undefined}
                      onCreateThread={onCreateThread ? () => onCreateThread(m.id) : undefined}
                      onCopy={onCopy ? () => onCopy(m.id) : undefined}
                      onRetry={onRetry ? () => onRetry(m.id) : undefined}
                      onPreviewImage={onPreviewImage}
                      onDownloadFile={onDownloadFile}
                      highlighted={jumped === m.id}
                      resolveUserName={resolveUserName}
                    />
                  </div>
                ))}
              </div>
            ))
          })()}

          {typingUsers && typingUsers.length > 0 && <TypingIndicator names={typingUsers} />}
        </div>
      </div>
    </div>
  )
}

// Loading placeholder for the message list. Mirrors the cluster layout used
// above (avatar + author line + 1–2 content lines) and sits inside the same
// flex-justify-end scroll container so the composer and header stay anchored.
// `dm` swaps the channel-style hero (small round icon + title + caption) for
// the DM hero shape (larger avatar + bigger title + caption). Kept colocated
// so changes to hero / row density don't drift between the two.
function MessageListSkeleton({ dm = false }: { dm?: boolean }) {
  const clusters: number[][] = [
    [220, 140],
    [180],
    [260, 90, 200],
    [120, 240],
    [200],
  ]
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-1 overflow-hidden">
        <div className="flex min-h-full flex-col justify-end px-4 py-8">
          <div className="mb-6">
            {dm ? (
              <>
                <Skeleton className="mb-3 size-17 rounded-full" />
                <Skeleton className="h-7 w-48 rounded" />
                <Skeleton className="mt-2 h-3.5 w-72 rounded" />
              </>
            ) : (
              <>
                <Skeleton className="mb-2 size-12 rounded-full" />
                <Skeleton className="h-5 w-40 rounded" />
                <Skeleton className="mt-2 h-3.5 w-80 max-w-full rounded" />
              </>
            )}
          </div>
          <div className="flex flex-col gap-3">
            {clusters.map((lines, i) => (
              <div key={i} className="flex gap-3 pt-1.5">
                <Skeleton className="size-9 shrink-0 rounded-full" />
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <div className="flex items-center gap-2">
                    <Skeleton className="h-4 w-24 rounded" />
                    <Skeleton className="h-3 w-14 rounded" />
                  </div>
                  {lines.map((w, j) => (
                    <Skeleton key={j} className="h-3.5 rounded" style={{ width: w }} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
