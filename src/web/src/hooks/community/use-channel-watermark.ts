"use client"

import { useEffect, useRef } from "react"
import { flushPendingReads } from "@/hooks/community/mutations/messages"
import { useAdvanceChannelWatermark } from "@/hooks/community/mutations/messages"
import type { Msg } from "@/components/community/_types"
import { useCurrentUser } from "@/contexts/community/current-user"

/**
 * Threshold at which a message must be visible before it counts as "read".
 * 0.2 = Discord-style: a message counts as read as soon as any meaningful
 * portion enters the viewport. Higher values (0.75, Slack-style) forced
 * users to scroll a full row PAST the viewport bottom before the watermark
 * would move — badges only cleared "when you dragged the message to the
 * very bottom." 0.2 clears them the moment a message is genuinely visible.
 */
const READ_VISIBILITY_THRESHOLD = 0.2

/**
 * Slack-style progressive read watermark. Observes every rendered message
 * row in the scroll container and, when a row hits ≥75% visibility, walks
 * the local `maxSeen` pointer forward and asks the mutation layer to PUT
 * the new pointer to the server (debounced 500ms — bursts collapse into a
 * single request).
 *
 * Invariants:
 *
 * - **Monotone forward.** Scrolling back never regresses the local
 *   `maxSeen`. The watermark only ever moves toward the newest visible id.
 * - **Self-authored messages are skipped.** The write-path already sets
 *   the sender's own `lastReadMessageId` when they post (see #1 in the
 *   plan) — a client PUT would be redundant.
 * - **On unmount, flush.** Any pending debounce fires immediately via
 *   `flushPendingReads()` so the last watched message isn't stranded in
 *   the debounce window.
 *
 * `scrollRootEl` must be the same element that scrolls the message list —
 * the `IntersectionObserver` uses it as `root` so ratios are computed
 * against the visible scroll frame, not the entire viewport.
 */
export function useChannelWatermark({
  channelId,
  messages,
  scrollRootEl,
}: {
  channelId: string | null | undefined
  messages: Msg[]
  scrollRootEl: HTMLElement | null
}) {
  const currentUser = useCurrentUser()
  const viewerId = currentUser.id
  const advance = useAdvanceChannelWatermark()

  // `maxSeen` is a `(createdAt, id)` pair — lex ordering so identical
  // createdAt strings still sort deterministically. Reset when the
  // channel changes so a switch between channels doesn't leak the prior
  // channel's pointer.
  const maxSeenRef = useRef<{ createdAt: string; id: string } | null>(null)
  useEffect(() => {
    maxSeenRef.current = null
  }, [channelId])

  // Keep the freshest `messages` array visible to the IntersectionObserver
  // callback via a ref — the callback captures once per observer re-attach
  // and shouldn't recreate on every render. WS-delivered new messages get
  // observed on the next render pass (see the effect below), so the ref
  // avoids stale-closure lookups when a row is measured.
  const messagesRef = useRef<Msg[]>(messages)
  const advanceRef = useRef(advance)
  useEffect(() => {
    messagesRef.current = messages
    advanceRef.current = advance
  })

  useEffect(() => {
    if (!channelId) return
    if (!scrollRootEl) return
    if (typeof IntersectionObserver === "undefined") return

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          if (entry.intersectionRatio < READ_VISIBILITY_THRESHOLD) continue
          const target = entry.target as HTMLElement
          const id = target.dataset.msgId
          if (!id) continue
          const msg = messagesRef.current.find((m) => m.id === id)
          if (!msg || !msg.createdAt) continue
          // Skip self-authored messages — see hook docstring.
          if (msg.authorId && msg.authorId === viewerId) continue

          const cur = maxSeenRef.current
          const isNewer =
            !cur ||
            msg.createdAt > cur.createdAt ||
            (msg.createdAt === cur.createdAt && id > cur.id)
          if (!isNewer) continue
          maxSeenRef.current = { createdAt: msg.createdAt, id }
          advanceRef.current(channelId, id)
        }
      },
      {
        root: scrollRootEl,
        threshold: READ_VISIBILITY_THRESHOLD,
      },
    )

    // Observe every currently-rendered message row. React re-runs this
    // effect whenever the `messages` reference changes (send / receive /
    // pagination), so the observer picks up fresh rows on the next render.
    const nodes = scrollRootEl.querySelectorAll<HTMLElement>("[data-msg-id]")
    nodes.forEach((n) => observer.observe(n))

    return () => observer.disconnect()
  }, [channelId, messages, scrollRootEl, viewerId])

  // On unmount / channel switch, flush the debounce so the last-watched
  // message isn't stranded in the pending window. `flushPendingReads`
  // fires every entry synchronously (no `await` — the PUT is fire-and-
  // forget, matching the mutation hook's contract).
  useEffect(() => {
    return () => {
      flushPendingReads()
    }
  }, [channelId])
}
