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
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (didInitialScrollRef.current) return
    if (messages.length === 0) return
    // Wait for the owner's async anchor (e.g. useChannelReadStateSnapshot)
    // — running the effect before newDividerBefore is known silently snaps
    // to the bottom and burns the one-shot gate.
    if (!initialScrollReady) return

    if (newDividerBefore) {
      const target = el.querySelector<HTMLElement>(
        `[data-msg-id="${cssEscape(newDividerBefore)}"]`,
      )
      if (target) {
        target.scrollIntoView({ block: "center", behavior: "smooth" })
        didInitialScrollRef.current = true
        return
      }
    }
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" })
    didInitialScrollRef.current = true
  }, [messages, newDividerBefore, initialScrollReady])

  // Rule #3: when the viewer sends a message, snap to the bottom.
  // Tracks the tail message id across renders and only fires when the tail
  // moves AND the new tail is authored by the viewer. `fetchOlder` prepends
  // older rows and leaves the tail id unchanged, so paging up never triggers
  // a jump. Peer sends move the tail but with a different authorId — those
  // stay on the "↓ N" pill path.
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
    if (tail.authorId !== viewerUserId) return
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" })
  }, [messages, viewerUserId])

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

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <ScrollDownButton
        count={belowCount}
        onClick={scrollToBottom}
      />
      <TypingIndicator names={typingUsers ?? []} />
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

        </div>
      </div>
    </div>
  )
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
function ScrollDownButton({ count, onClick }: { count: number; onClick: () => void }) {
  const visible = count > 0
  return (
    <div
      className={`pointer-events-none absolute bottom-3 left-1/2 z-10 -translate-x-1/2 transition-all duration-200 ease-out ${
        visible ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0"
      }`}
    >
      <button
        type="button"
        onClick={onClick}
        aria-label={`Scroll to bottom, ${count} more below`}
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
