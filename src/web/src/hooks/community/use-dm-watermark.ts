"use client"

import { useEffect, useRef } from "react"
import { flushPendingReads } from "@/hooks/community/mutations/messages"
import { useAdvanceDmWatermark } from "@/hooks/community/mutations/messages"
import type { Msg } from "@/components/community/_types"
import { useCurrentUser } from "@/contexts/community/current-user"

/**
 * See `use-channel-watermark.ts` for the rationale — mirrors channel side.
 * MUST stay identical or DM and channel divider timing drifts.
 */
const READ_VISIBILITY_THRESHOLD = 0.2

/**
 * Slack-style progressive read watermark for DMs. Behaves identically to
 * `useChannelWatermark` — same threshold, same monotone `maxSeen` ref,
 * same self-authored skip, same flush-on-unmount contract. The shape is
 * intentionally mirrored so bugs fixed on one side reach the other:
 * this is single-source-of-truth for the watermark UX, split into two
 * hook files only because the write path differs (`useAdvanceDmWatermark`
 * PUTs `/dm/:id/read` instead of `/channels/:id/read`).
 *
 * See `useChannelWatermark` for the full invariant list. Any change to
 * that hook's ratio, ordering, or lifecycle rules MUST be mirrored here
 * or the DM divider / read pointer will drift out of parity with
 * channels.
 */
export function useDmWatermark({
  dmId,
  messages,
  scrollRootEl,
}: {
  dmId: string | null | undefined
  messages: Msg[]
  scrollRootEl: HTMLElement | null
}) {
  const currentUser = useCurrentUser()
  const viewerId = currentUser.id
  const advance = useAdvanceDmWatermark()

  // `maxSeen` is a `(createdAt, id)` pair — lex ordering so identical
  // createdAt strings still sort deterministically. Reset when the DM
  // changes so a switch between DMs doesn't leak the prior DM's pointer.
  const maxSeenRef = useRef<{ createdAt: string; id: string } | null>(null)
  useEffect(() => {
    maxSeenRef.current = null
  }, [dmId])

  // Keep the freshest `messages` array visible to the IntersectionObserver
  // callback via a ref — the callback captures once per observer re-attach
  // and shouldn't recreate on every render. See channel hook for details.
  const messagesRef = useRef<Msg[]>(messages)
  const advanceRef = useRef(advance)
  useEffect(() => {
    messagesRef.current = messages
    advanceRef.current = advance
  })

  useEffect(() => {
    if (!dmId) return
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
          // Skip self-authored messages — mirrors channel hook. Server
          // stamps the sender's own watermark on POST so a client PUT
          // here would be redundant.
          if (msg.authorId && msg.authorId === viewerId) continue

          const cur = maxSeenRef.current
          const isNewer =
            !cur ||
            msg.createdAt > cur.createdAt ||
            (msg.createdAt === cur.createdAt && id > cur.id)
          if (!isNewer) continue
          maxSeenRef.current = { createdAt: msg.createdAt, id }
          advanceRef.current(dmId, id)
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

    // The message list is virtualized — rows mount/unmount as the user
    // scrolls, WITHOUT any `messages` array change to re-run this effect.
    // Mirrors the channel hook: watch the scroll root for added
    // `[data-msg-id]` nodes and observe them so a row scrolled into view
    // after mount still advances the read watermark. See
    // `useChannelWatermark` for the full rationale — kept identical for
    // divider/read-pointer parity.
    let mutationObserver: MutationObserver | null = null
    if (typeof MutationObserver !== "undefined") {
      mutationObserver = new MutationObserver((records) => {
        for (const record of records) {
          record.addedNodes.forEach((node) => {
            // Element nodes only (skip text/comment nodes — nodeType 1).
            if ((node as { nodeType?: number }).nodeType !== 1) return
            const el = node as Element
            if (el.matches?.("[data-msg-id]")) observer.observe(el)
            el.querySelectorAll?.("[data-msg-id]").forEach((n) => observer.observe(n))
          })
        }
      })
      mutationObserver.observe(scrollRootEl, { childList: true, subtree: true })
    }

    return () => {
      observer.disconnect()
      mutationObserver?.disconnect()
    }
  }, [dmId, messages, scrollRootEl, viewerId])

  // On unmount / DM switch, flush the debounce so the last-watched message
  // isn't stranded in the pending window. `flushPendingReads` fires every
  // entry (channel + DM) — safe because each entry's `fire` is idempotent
  // and only the ones scheduled here belong to this DM's write path.
  useEffect(() => {
    return () => {
      flushPendingReads()
    }
  }, [dmId])
}
