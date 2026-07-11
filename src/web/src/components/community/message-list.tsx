"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ArrowDown } from "lucide-react"
import { DateDivider, NewDivider } from "./dividers"
import { Message } from "./message"
import { TypingIndicator } from "./typing-indicator"
import { dateKey, formatDateLabel } from "./format-time"
import { ChannelIcon } from "./channel-icon"
import { Skeleton } from "@/components/ui/skeleton"
import { NumberTicker } from "@/components/ui/number-ticker"
import { useScrollAnchor, cssEscape } from "@/hooks/community/use-scroll-anchor"
import type { Msg, RenderMsg, OpenProfile } from "./_types"

// Consecutive messages from the same author cluster (avatar+name suppressed
// on the second+ row) when they land within this window of each other.
const MESSAGE_GROUP_WINDOW_MS = 7 * 60 * 1000

// Channel message list — welcome hero, date dividers, messages (with the NEW divider),
// and typing indicator. Data via props.
export function MessageList({
  channel, messages, loading, pinnedIds, newDividerBefore, typingUsers, onOpenThread, onOpenProfile,
  onToggleReaction, onReact,
  onReply, onPin, onCreateThread, onCopy, onRetry, onPreviewImage, onDownloadFile,
  resolveUserName, scrollToMessageId, hero, variant = "channel", onScrollRoot, viewerUserId, initialScrollReady = true,
  hasMore, isFetchingOlder, onLoadOlder,
  hasMoreNewer, isFetchingNewer, onLoadNewer, onJumpToPresent, unreadCount,
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
  // Explicit skeleton-shape selector — replaces the old `dm={!!hero}`
  // inference, which silently misfired the moment a channel-context loading
  // `hero` was introduced (the skeleton's DM/channel shape and the `hero`
  // slot are orthogonal concerns; `hero`'s presence was never a reliable
  // signal for which one this view is).
  variant?: "channel" | "dm"
  /**
   * Called with the scroll-root element once it mounts (and `null` on
   * unmount). Consumers (e.g. `useChannelWatermark`) use this to observe
   * `[data-msg-id]` rows against the correct viewport root rather than the
   * page's default viewport.
   */
  onScrollRoot?: (el: HTMLDivElement | null) => void
  // Viewer id — enables "scroll to bottom when the viewer sends a message".
  // Without this the auto-follow only fires at mount time; incoming peer
  // messages never pull the view.
  viewerUserId?: string
  // Gate for the mount-time initial scroll. Owners that need to wait for
  // async NEW-divider anchor data (`useChannelReadStateSnapshot`) pass
  // `false` until the snapshot resolves; otherwise the effect fires with a
  // stale `newDividerBefore = undefined` and snaps to bottom before the
  // anchor is known.
  initialScrollReady?: boolean
  // Reverse-infinite scroll. When `hasMore` is true a top sentinel is
  // rendered; when it enters the viewport (via IntersectionObserver on the
  // scroll root) `onLoadOlder()` fires. The prepended rows are scroll-
  // anchored below (see `useScrollAnchor`) so the user's visual position
  // stays fixed.
  hasMore?: boolean
  isFetchingOlder?: boolean
  onLoadOlder?: () => void
  // Forward-infinite scroll (bi-directional pagination — A2). When the
  // initial page is an anchor window in the middle of history, the tail is
  // NOT the newest message; a bottom sentinel is rendered until the user
  // scrolls into it to request newer rows. Legacy newest-attached mode
  // leaves `hasMoreNewer` undefined/false — no bottom sentinel.
  hasMoreNewer?: boolean
  isFetchingNewer?: boolean
  onLoadNewer?: () => void
  // `↓ N` pill — when there are messages further ahead than the loaded
  // window, clicking jumps back to the present. Falls back to the DOM
  // `belowCount` scroll-to-bottom when we're already tail-attached.
  onJumpToPresent?: () => void
  // Server-derived unread count (`latestSeq - viewerLastReadSeq`). Drives
  // the `↓ N` badge when `hasMoreNewer` is true — DOM math can't see rows
  // that haven't been fetched yet.
  unreadCount?: number
}) {
  const [jumped, setJumped] = useState<string | null>(null)

  // All automatic scroll-anchor decisions (mount / self-send / peer-follow /
  // prepend / hero-swap) live in this hook — see `use-scroll-anchor.ts` for
  // the consolidated decision logic that replaces the previously-scattered
  // 3 effects / 5+ refs / 2 disagreeing thresholds.
  const { scrollRef, belowCount, scrollToBottom } = useScrollAnchor({
    messages,
    newDividerBefore,
    initialScrollReady,
    hasMore,
    hasMoreNewer,
    viewerUserId,
  })

  // Publish the scroll root to interested consumers (watermark observer).
  // The callback identity may vary across renders; only re-invoke when the
  // element itself changes.
  useEffect(() => {
    if (!onScrollRoot) return
    onScrollRoot(scrollRef.current)
    return () => onScrollRoot(null)
  }, [onScrollRoot, scrollRef])

  // Top sentinel — when it intersects the scroll root's viewport, request the
  // next older page. Mirrors the pattern in member-list.tsx: root is the
  // scroll container (NOT the page viewport), rootMargin `200px` so the
  // fetch kicks in before the user hits the true edge.
  const topSentinelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!onLoadOlder || !hasMore) return
    const el = topSentinelRef.current
    const root = scrollRef.current
    if (!el || !root) return
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && !isFetchingOlder) onLoadOlder()
        }
      },
      { root, rootMargin: "200px" },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [onLoadOlder, hasMore, isFetchingOlder, scrollRef])

  // Bottom sentinel — symmetric to the top one. Only mounted when the loaded
  // window is not tail-attached (`hasMoreNewer === true`). Appended rows from
  // a newer-fetch prepend to `pages[0]` in cache order → after the sort in
  // `mergeMessagesPages` they land at the natural tail of `messages`, which
  // grows the container downward and leaves the viewer's scrollTop untouched.
  // No compensating scroll needed.
  const bottomSentinelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!onLoadNewer || !hasMoreNewer) return
    const el = bottomSentinelRef.current
    const root = scrollRef.current
    if (!el || !root) return
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && !isFetchingNewer) onLoadNewer()
        }
      },
      { root, rootMargin: "200px" },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [onLoadNewer, hasMoreNewer, isFetchingNewer, scrollRef])

  const jumpTo = useCallback((id: string) => {
    setJumped(id)
    // Scoped to the scroll root (not `document.getElementById`) and keyed
    // off `[data-msg-id]` — the attribute every row already carries for
    // `useChannelWatermark`'s IntersectionObserver and `useScrollAnchor`'s
    // mount-time NEW-divider lookup. Replaces the removed `dpv-${id}` DOM
    // id, which was redundant with this attribute (#1).
    scrollRef.current
      ?.querySelector<HTMLElement>(`[data-msg-id="${cssEscape(id)}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" })
    window.setTimeout(() => setJumped((v) => (v === id ? null : v)), 1600)
  }, [scrollRef])

  useEffect(() => {
    if (scrollToMessageId) jumpTo(scrollToMessageId)
  }, [scrollToMessageId, jumpTo])

  // Group consecutive messages from the same author into clusters. Memoized
  // so a re-render triggered by unrelated state (typing indicator ticks,
  // presence updates, etc.) doesn't re-walk the full message list every time.
  const clusters = useMemo(() => {
    const result: { messages: { m: RenderMsg; showDateDivider: boolean; showNewDivider: boolean }[] }[] = []
    messages.forEach((m, i) => {
      const prev = i > 0 ? messages[i - 1] : null
      const prevDate = prev ? dateKey(prev.createdAt) : ""
      const curDate = dateKey(m.createdAt)
      const showDateDivider = !!(curDate && curDate !== prevDate)
      const grouped = !!(prev && m.type === "chat" && !m.replyTo && !showDateDivider && prev.authorName === m.authorName
        && prev.createdAt && m.createdAt && (new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime()) < MESSAGE_GROUP_WINDOW_MS)
      const entry = { m: { ...m, grouped }, showDateDivider, showNewDivider: m.id === newDividerBefore }
      if (grouped && result.length > 0) {
        result[result.length - 1].messages.push(entry)
      } else {
        result.push({ messages: [entry] })
      }
    })
    return result
  }, [messages, newDividerBefore])

  // `isLoading` drives which content renders INSIDE the tree below, rather
  // than an early `return` producing a structurally different element tree
  // — the same `<MessageList>` instance (and the same `scrollRef`-bearing
  // div) stays mounted across the loading→loaded transition (the page-level
  // fix in the 4 community pages is what stops the unwanted REMOUNT; this
  // internal change is what keeps the two states on one DOM structure, per
  // DESIGN.md's "Fade, don't swap" — same dimensions/position/layout flow,
  // ready for a real crossfade later).
  const isLoading = !!loading && messages.length === 0

  // ↓ N pill precedence:
  //   - When there are messages the client hasn't fetched yet
  //     (`hasMoreNewer`), show the server-derived `unreadCount` (may be
  //     larger than the DOM `belowCount`) and click → `onJumpToPresent`
  //     resets the query to newest, cutting out multi-RTT page walks.
  //   - Otherwise fall back to `belowCount` and `scrollToBottom` — the
  //     tail-attached path unchanged from pre-A2.
  const jumpMode = !!hasMoreNewer
  const pillCount = jumpMode
    ? ((unreadCount ?? belowCount) || 0)
    : belowCount
  const pillOnClick = jumpMode
    ? (onJumpToPresent ?? scrollToBottom)
    : scrollToBottom

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <ScrollDownButton
        count={isLoading ? 0 : pillCount}
        mode={jumpMode ? "jump" : "scroll"}
        onClick={pillOnClick}
      />
      <TypingIndicator names={isLoading ? [] : typingUsers ?? []} />
      <div ref={scrollRef} className="flex-1 overflow-y-auto thin-scrollbar">
        <div className="flex min-h-full flex-col justify-end px-4 py-8">
          {isLoading ? (
            <MessageListSkeletonContent variant={variant} />
          ) : (
            <>
              {/*
                When `hasMore` is true the hero's "Beginning of …" copy would
                lie — there's more history above — so we swap it for the top
                sentinel + inline "Loading older messages…" indicator. Once
                the last page loads (`hasMore === false`) the hero returns
                and reads as "you've reached the top".
              */}
              {hasMore ? (
                <div
                  ref={topSentinelRef}
                  className="mb-6 flex h-8 items-center justify-center text-xs text-muted-foreground"
                >
                  {isFetchingOlder ? "Loading older messages…" : ""}
                </div>
              ) : (
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
              )}

              {clusters.map((cluster, ci) => (
                <div key={cluster.messages[0].m.id ?? ci}>
                  {cluster.messages.map(({ m, showDateDivider, showNewDivider }) => (
                    // `data-msg-id` anchors the IntersectionObserver in
                    // `useChannelWatermark` — every rendered row is a candidate
                    // for the read pointer, and is `useScrollAnchor`'s
                    // fallback mount target when there's no NEW divider to
                    // center on. `NewDivider` itself carries `data-new-divider`,
                    // which `useScrollAnchor` prefers when present.
                    <div key={m.id} data-msg-id={m.id}>
                      {showDateDivider && <DateDivider label={formatDateLabel(m.createdAt!)} />}
                      {showNewDivider && <NewDivider />}
                      <Message
                        m={m}
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
              ))}

              {hasMoreNewer && (
                <div
                  ref={bottomSentinelRef}
                  className="mt-6 flex h-8 items-center justify-center text-xs text-muted-foreground"
                >
                  {isFetchingNewer ? "Loading newer messages…" : ""}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// Floating "↓ N" pill that appears when the user has scrolled up and there
// are still messages below the viewport. `count === 0` hides the button
// entirely (fade + slide-down, matches the shared scroll-to-bottom pill's
// visual language).
//
// `mode="jump"` — the loaded window is not tail-attached (bi-directional
// pagination has more newer rows to fetch); click jumps to present rather
// than a plain scroll. `mode="scroll"` — legacy tail-attached path.
function ScrollDownButton({
  count,
  mode = "scroll",
  onClick,
}: {
  count: number
  mode?: "scroll" | "jump"
  onClick: () => void
}) {
  const visible = count > 0
  const aria = mode === "jump"
    ? `Jump to present, ${count} unread below`
    : `Scroll to bottom, ${count} more below`
  return (
    <div
      className={`pointer-events-none absolute bottom-3 left-1/2 z-10 -translate-x-1/2 transition-all duration-200 ease-out ${
        visible ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0"
      }`}
    >
      <button
        type="button"
        onClick={onClick}
        aria-label={aria}
        className={`pointer-events-auto flex h-8 items-center gap-1.5 rounded-full border border-border bg-background/90 pl-2 pr-3 text-xs font-medium text-foreground shadow-(--e1) backdrop-blur-sm transition-colors hover:bg-accent ${
          visible ? "" : "pointer-events-none"
        }`}
      >
        <ArrowDown className="size-3.5 text-muted-foreground" />
        <NumberTicker value={count} />
      </button>
    </div>
  )
}

// Loading placeholder content — rendered INSIDE `<MessageList>`'s own
// scroll-container tree (see `isLoading` above), not as a separately-
// returned component with its own wrapper divs. This is what makes the
// loading→loaded transition a props change on one mounted instance rather
// than a swap between two structurally different trees. `variant` swaps the
// channel-style hero (small round icon + title + caption) for the DM hero
// shape (larger avatar + bigger title + caption) — an explicit prop now
// (previously inferred from `!!hero`, which silently misfired whenever a
// caller passed a channel-context loading `hero`; `hero` and the skeleton's
// DM/channel shape are orthogonal concerns).
function MessageListSkeletonContent({ variant }: { variant: "channel" | "dm" }) {
  const clusters: number[][] = [
    [220, 140],
    [180],
    [260, 90, 200],
    [120, 240],
    [200],
  ]
  return (
    <>
      <div className="mb-6">
        {variant === "dm" ? (
          <>
            <Skeleton className="mb-3 size-16 rounded-full" />
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
            <Skeleton className="size-10 shrink-0 rounded-full" />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
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
    </>
  )
}
