"use client"

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { ArrowDown } from "lucide-react"
import { DateDivider, NewDivider } from "./dividers"
import { Message } from "./message"
import { TypingIndicator } from "./typing-indicator"
import { dateKey, formatDateLabel } from "./format-time"
import { ChannelIcon } from "./channel-icon"
import { Skeleton } from "@/components/ui/skeleton"
import { NumberTicker } from "@/components/ui/number-ticker"
import type { Msg, OpenProfile } from "./_types"

// Channel message list — welcome hero, date dividers, messages (with the NEW divider),
// and typing indicator. Data via props.
export function MessageList({
  channel, messages, loading, pinnedIds, newDividerBefore, typingUsers, onOpenThread, onOpenProfile,
  onToggleReaction, onReact,
  onReply, onPin, onCreateThread, onCopy, onRetry, onPreviewImage, onDownloadFile,
  resolveUserName, scrollToMessageId, hero, onScrollRoot, viewerUserId, initialScrollReady = true,
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
  // anchored below (see the useLayoutEffect on head-id changes) so the
  // user's visual position stays fixed.
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
  const scrollRef = useRef<HTMLDivElement>(null)
  // Tracks whether the mount-time initial-scroll has fired yet. On channel
  // switch (`messages` cleared) we reset it so the new channel gets its own
  // initial scroll.
  const didInitialScrollRef = useRef(false)

  // Publish the scroll root to interested consumers (watermark observer).
  // The callback identity may vary across renders; only re-invoke when the
  // element itself changes.
  useEffect(() => {
    if (!onScrollRoot) return
    onScrollRoot(scrollRef.current)
    return () => onScrollRoot(null)
  }, [onScrollRoot])

  useEffect(() => {
    if (messages.length === 0) {
      didInitialScrollRef.current = false
    }
  }, [messages.length])

  // Mount-time initial scroll — exactly two rules, no auto-follow after:
  //   1. NEW divider present → center it vertically in the viewport.
  //   2. No NEW divider → snap to the bottom.
  // Fires once per mount; deliberately no near-bottom heuristic. If the
  // user has scrolled up, incoming messages do NOT pull the view back —
  // the floating "↓ N" button below is how they return, and the sibling
  // "self-send" effect handles the composer path.
  //
  // Owners key `<MessageList>` on channelId/dmId, so channel switches
  // remount the component and reset this ref — no explicit reset logic
  // needed here.
  //
  // Cold-cache guard (RO watchdog): on a hard reload the browser hasn't
  // decoded any embedded images yet, so `scrollHeight` when the initial
  // scroll fires is the pre-image height. Images arrive over the next
  // few hundred ms and push the target out of view. A ResizeObserver on
  // the scroll container re-invokes the same action on every subsequent
  // layout change, until the user scrolls or 3s elapses. Later mounts
  // (channel switch within session) skip this because the browser image
  // cache is warm and layout is stable on the first frame.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (didInitialScrollRef.current) return
    if (messages.length === 0) return
    // Wait for the owner's async anchor (e.g. useChannelReadStateSnapshot)
    // — running the effect before newDividerBefore is known silently snaps
    // to the bottom and burns the one-shot gate.
    if (!initialScrollReady) return

    let action: () => void
    if (newDividerBefore) {
      const target = el.querySelector<HTMLElement>(
        `[data-msg-id="${cssEscape(newDividerBefore)}"]`,
      )
      if (target) {
        // Compute scrollTop manually rather than use `scrollIntoView({
        // block: "center" })`. The scroll root's content lives inside a
        // `flex justify-end min-h-full` wrapper; some engines interpret
        // `block: "center"` against that wrapper's flex flow rather than
        // the scroll root's viewport, and the row lands at the top of
        // the viewport instead of the middle. Bounding-rect delta works
        // regardless of offsetParent since it's viewport-space math.
        // Instant, not smooth — same reason as the self-send effect
        // below: smooth animations race the RO re-pins on some engines
        // and can snap back to the pre-image target.
        action = () => {
          const targetRect = target.getBoundingClientRect()
          const scrollRect = el.getBoundingClientRect()
          const targetTopInScroller = targetRect.top - scrollRect.top + el.scrollTop
          const desired = targetTopInScroller - (el.clientHeight - target.offsetHeight) / 2
          el.scrollTop = Math.max(0, desired)
        }
      } else {
        action = () => el.scrollTo({ top: el.scrollHeight })
      }
    } else {
      action = () => el.scrollTo({ top: el.scrollHeight })
    }
    action()
    didInitialScrollRef.current = true

    return watchAsyncGrowth(el, action)
  }, [messages, newDividerBefore, initialScrollReady])

  // Rule #3: when the viewer sends a message, snap to the bottom.
  // Tracks the tail message id across renders and only fires when the tail
  // moves AND the new tail is authored by the viewer. `fetchOlder` prepends
  // older rows and leaves the tail id unchanged, so paging up never triggers
  // a jump. Peer sends move the tail but with a different authorId — those
  // stay on the "↓ N" pill path.
  //
  // The tail row can keep growing after the initial scrollTo — images
  // decode, mermaid diagrams render, invite cards resolve — all shove the
  // composer off the viewport. A ResizeObserver on the tail row re-pins to
  // the bottom on every size change, regardless of the source. Bails once
  // the user scrolls away (`wheel` / `touchstart`), so an image loading in
  // the background never yanks a scrolled-up reader.
  const lastTailIdRef = useRef<string | null>(null)
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (messages.length === 0) {
      lastTailIdRef.current = null
      return
    }
    const tail = messages[messages.length - 1]
    const prev = lastTailIdRef.current
    lastTailIdRef.current = tail.id
    if (prev === null) return
    if (prev === tail.id) return
    if (!viewerUserId) return

    // Self-send: viewer authored the new tail → always follow. Handles the
    // composer path across image/mermaid/invite-card async growth via the
    // RO re-pin below.
    const isSelfSend = tail.authorId === viewerUserId

    // Peer follow: someone else sent a message AND the viewer is already at
    // (or near) the bottom → snap to the new tail. If the viewer has
    // scrolled up, we leave the "↓ N" pill to prompt them back down.
    //
    // Gated on `hasMoreNewer === false` (i.e. the loaded window is
    // tail-attached to the present) so a peer message WS-inserted while
    // the viewer is browsing history doesn't yank the view to a message
    // that isn't actually "now". The pill's jump-to-present covers that
    // case.
    let isPeerFollow = false
    if (!isSelfSend) {
      if (hasMoreNewer) return
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
      // 100px window matches the pill's "near bottom" intuition — noise
      // (anti-aliasing, sub-pixel layout) is well below one line height,
      // and a scrolled-up reader is typically many lines above.
      if (distanceFromBottom >= 100) return
      isPeerFollow = true
    }

    if (!isSelfSend && !isPeerFollow) return

    // Instant, not smooth. `behavior: 'smooth'` conflicts with the RO
    // re-pins below — the browser's ongoing smooth animation and our
    // subsequent instant scrollTo race, and on some engines the smooth
    // animation "wins" by continuing to its stored target after the
    // instant jump lands, snapping the view back up.
    const action = () => el.scrollTo({ top: el.scrollHeight })
    action()
    return watchAsyncGrowth(el, action)
  }, [messages, viewerUserId, hasMoreNewer])

  // Reverse-infinite scroll anchor. When older messages prepend (head id
  // changes but tail id stays put), the browser's default is to keep
  // `scrollTop` constant, which visually shoves the user's current row down
  // by the height of the newly-inserted content. We snapshot the pre-commit
  // `scrollHeight` before the messages array updates and, once the DOM
  // reflects the new rows, add the height delta to `scrollTop` so the
  // user's current view stays fixed.
  //
  // Also handles the `hasMore` transition true → false: when a fetchOlder
  // reaches start-of-history the ~32px top sentinel is replaced by the
  // ~120px hero card. `messages` may not have grown at all (start-of-
  // history sometimes returns 0 rows), but the top block gained ~90px and
  // every row below it visibly shifts down. Snapshotting `scrollHeight`
  // across the flip and adding the positive delta pins the viewer's row.
  //
  // Only fires after the mount-time initial scroll has landed
  // (`didInitialScrollRef.current === true`) — otherwise we'd fight the
  // one-shot snap on first mount. Skipped when the tail id changed (that's
  // a self-send or a peer send, handled elsewhere) or when `messages`
  // shrank (channel switch, handled by the length===0 reset above).
  const prevHeadIdRef = useRef<string | null>(null)
  const prevTailIdRef = useRef<string | null>(null)
  const prevScrollHeightRef = useRef<number>(0)
  const prevMessagesLenRef = useRef<number>(0)
  const prevHasMoreRef = useRef<boolean | undefined>(hasMore)
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) {
      prevHeadIdRef.current = messages[0]?.id ?? null
      prevTailIdRef.current = messages[messages.length - 1]?.id ?? null
      prevMessagesLenRef.current = messages.length
      prevScrollHeightRef.current = 0
      prevHasMoreRef.current = hasMore
      return
    }
    const prevHead = prevHeadIdRef.current
    const prevTail = prevTailIdRef.current
    const prevLen = prevMessagesLenRef.current
    const prevHeight = prevScrollHeightRef.current
    const prevHasMore = prevHasMoreRef.current
    const nextHead = messages[0]?.id ?? null
    const nextTail = messages[messages.length - 1]?.id ?? null
    const nextLen = messages.length
    const nextHeight = el.scrollHeight

    const olderPrepended =
      prevHead !== null &&
      nextHead !== null &&
      prevHead !== nextHead &&
      nextLen > prevLen
    // Hero swap: `hasMore` flipped true → false while the tail stayed put.
    // Even when 0 rows landed on the last page, the top block grew from
    // sentinel to hero and everything below shifted down.
    const heroSwap =
      prevHasMore === true &&
      hasMore === false &&
      prevTail !== null &&
      prevTail === nextTail

    if (
      didInitialScrollRef.current &&
      prevHeight > 0 &&
      (olderPrepended || heroSwap)
    ) {
      const delta = nextHeight - prevHeight
      if (delta > 0) el.scrollTop = el.scrollTop + delta
    }

    prevHeadIdRef.current = nextHead
    prevTailIdRef.current = nextTail
    prevMessagesLenRef.current = nextLen
    prevScrollHeightRef.current = nextHeight
    prevHasMoreRef.current = hasMore
  }, [messages, hasMore])

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
  }, [onLoadOlder, hasMore, isFetchingOlder])

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
  }, [onLoadNewer, hasMoreNewer, isFetchingNewer])

  // Live count of messages sitting below the viewport. Recomputed on scroll,
  // on messages change, and via a ResizeObserver so appended rows update the
  // badge even without a scroll event. `0` means the user is at the bottom
  // (or the list fits entirely in the viewport) — the button hides.
  const [belowCount, setBelowCount] = useState(0)
  const recomputeBelow = useCallback(() => {
    const el = scrollRef.current
    if (!el) {
      setBelowCount(0)
      return
    }
    // Ignore near-bottom noise (a few px off from anti-aliasing / sub-pixel
    // layout counts as "at bottom"). 8px is well below one line's height.
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    if (distanceFromBottom < 8) {
      setBelowCount(0)
      return
    }
    const rows = el.querySelectorAll<HTMLElement>("[data-msg-id]")
    const viewportBottom = el.scrollTop + el.clientHeight
    let count = 0
    for (const row of rows) {
      if (row.offsetTop >= viewportBottom) count++
    }
    setBelowCount(count)
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    recomputeBelow()
    el.addEventListener("scroll", recomputeBelow, { passive: true })
    const ro = new ResizeObserver(recomputeBelow)
    ro.observe(el)
    return () => {
      el.removeEventListener("scroll", recomputeBelow)
      ro.disconnect()
    }
  }, [recomputeBelow, messages.length])

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" })
  }, [])

  const jumpTo = (id: string) => {
    setJumped(id)
    document.getElementById(`dpv-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" })
    window.setTimeout(() => setJumped((v) => (v === id ? null : v)), 1600)
  }

  useEffect(() => {
    if (scrollToMessageId) jumpTo(scrollToMessageId)
  }, [scrollToMessageId])

  // Group consecutive messages from the same author into clusters. Memoized
  // so a re-render triggered by unrelated state (typing indicator ticks,
  // presence updates, etc.) doesn't re-walk the full message list every time.
  const clusters = useMemo(() => {
    const result: { messages: { m: Msg; grouped: boolean; showDateDivider: boolean; showNewDivider: boolean }[] }[] = []
    messages.forEach((m, i) => {
      const prev = i > 0 ? messages[i - 1] : null
      const prevDate = prev ? dateKey(prev.createdAt) : ""
      const curDate = dateKey(m.createdAt)
      const showDateDivider = !!(curDate && curDate !== prevDate)
      const grouped = !!(prev && !m.type && !m.replyTo && !showDateDivider && prev.authorName === m.authorName
        && prev.createdAt && m.createdAt && (new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime()) < 420_000)
      const entry = { m, grouped, showDateDivider, showNewDivider: m.id === newDividerBefore }
      if (grouped && result.length > 0) {
        result[result.length - 1].messages.push(entry)
      } else {
        result.push({ messages: [entry] })
      }
    })
    return result
  }, [messages, newDividerBefore])

  // All hooks must run before any conditional return — rule-of-hooks.
  if (loading && messages.length === 0) return <MessageListSkeleton dm={!!hero} />

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
        count={pillCount}
        mode={jumpMode ? "jump" : "scroll"}
        onClick={pillOnClick}
      />
      <TypingIndicator names={typingUsers ?? []} />
      <div ref={scrollRef} className="flex-1 overflow-y-auto thin-scrollbar">
        <div className="flex min-h-full flex-col justify-end px-4 py-8">
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
              {cluster.messages.map(({ m, grouped, showDateDivider, showNewDivider }) => (
                // `data-msg-id` anchors the IntersectionObserver in
                // `useChannelWatermark` — every rendered row is a candidate
                // for the read pointer. Also used by the mount-time
                // "scroll to New divider" effect above.
                <div key={m.id} data-msg-id={m.id}>
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
          ))}

          {hasMoreNewer && (
            <div
              ref={bottomSentinelRef}
              className="mt-6 flex h-8 items-center justify-center text-xs text-muted-foreground"
            >
              {isFetchingNewer ? "Loading newer messages…" : ""}
            </div>
          )}

        </div>
      </div>
    </div>
  )
}

// Re-invoke `action` whenever the scroll container's own size changes.
// Serves both initial scroll (images decoding on a cold browser cache
// arrive after the first scrollTo — target row was still short at that
// moment) and self-send (composer stays in view when an image the user
// just attached finishes decoding).
//
// Bails when:
// - the user scrolls (wheel / touchstart — the only reliable "user
//   intent" signal during async growth; programmatic scroll fires its
//   own `scroll` events, so scrollTop comparisons can't distinguish).
// - the watchdog window elapses (3s — long enough for large images and
//   mermaid renders, short enough that the effect doesn't linger).
//
// rAF coalescing: multiple ResizeObserver fires in the same frame
// dispatch one `action` call. Without this, several images finishing
// decode in one layout tick would each call `action` on an intermediate
// scrollHeight before the browser settles on the final value.
//
// Returns a cleanup that owners MUST return from their effect.
const ASYNC_GROWTH_WINDOW_MS = 3000
function watchAsyncGrowth(el: HTMLElement, action: () => void): () => void {
  // Observe the scroll container's FIRST child — the content wrapper.
  // The scroll container itself has a fixed (`flex-1`) box; its size
  // doesn't change when children grow. The wrapper does grow, and its
  // border-box growth is what pushes `scrollHeight` up.
  const content = el.firstElementChild as HTMLElement | null
  if (!content) return () => {}

  let userIntervened = false
  const markIntervened = () => { userIntervened = true }
  el.addEventListener("wheel", markIntervened, { passive: true })
  el.addEventListener("touchstart", markIntervened, { passive: true })

  // Skip the RO's synchronous initial callback (fired once with the
  // current size at observe() time) — otherwise we'd re-run `action`
  // against the pre-growth height and waste a frame.
  let firstCallback = true
  let rafId: number | null = null
  const scheduleAction = () => {
    if (rafId !== null) return
    rafId = requestAnimationFrame(() => {
      rafId = null
      if (userIntervened) return
      action()
    })
  }
  const ro = new ResizeObserver(() => {
    if (firstCallback) { firstCallback = false; return }
    scheduleAction()
  })
  ro.observe(content)

  const timeoutId = window.setTimeout(() => {
    ro.disconnect()
  }, ASYNC_GROWTH_WINDOW_MS)

  return () => {
    el.removeEventListener("wheel", markIntervened)
    el.removeEventListener("touchstart", markIntervened)
    if (rafId !== null) cancelAnimationFrame(rafId)
    window.clearTimeout(timeoutId)
    ro.disconnect()
  }
}

// Escape a message id for safe use inside an attribute selector. Message ids
// are nanoids in production (URL-safe alphabet), but the temp-id path
// (`temp_<Date.now()>_<rand>`) contains underscores that CSS accepts unescaped
// too. This is defensive against a future format change — CSS.escape is native
// in every runtime we ship to, but SSR and older test envs may lack it, so we
// fall back to a conservative replacer for non-identifier characters.
function cssEscape(id: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(id)
  }
  return id.replace(/[^a-zA-Z0-9_-]/g, "\\$&")
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
        </div>
      </div>
    </div>
  )
}
