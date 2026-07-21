"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import type { Mention, UnreadDm, UnreadServer } from "@/components/community/_types"

/**
 * Inbox auto-collapse.
 *
 * The inbox popover should close by itself the moment the row the user clicked
 * leaves the list — and only then. Clicking a row that merely navigates (e.g. a
 * forum-channel parent, whose unread posts aren't read by visiting the listing)
 * keeps its `channel:<id>` row present, so the popover stays open.
 *
 * The mechanism: record the clicked row's key (a "pending close" marker held in
 * a ref so setting it doesn't render), then watch the inbox lists. When that
 * exact key is no longer present, collapse.
 *
 * Row → key:
 *   - DM row      → `dm:<dmConversationId>`
 *   - channel row → `channel:<channelId>` (top-level OR nested thread/forum-post)
 *   - mention row → `mention:<mention.id>`
 */

export type InboxLists = {
  unreads: UnreadServer[]
  unreadDms: UnreadDm[]
  mentions: Mention[]
}

// Pure: is the keyed row still somewhere in the inbox lists?
export function inboxItemPresent(lists: InboxLists, key: string): boolean {
  const sep = key.indexOf(":")
  if (sep < 0) return false
  const kind = key.slice(0, sep)
  const id = key.slice(sep + 1)
  switch (kind) {
    case "dm":
      return lists.unreadDms.some((d) => d.dmConversationId === id)
    case "channel":
      return lists.unreads.some((s) =>
        s.channels.some(
          (c) => c.channelId === id || c.children.some((ch) => ch.channelId === id),
        ),
      )
    case "mention":
      return lists.mentions.some((m) => m.id === id)
    default:
      return false
  }
}

export function useInboxAutoCollapse({ unreads, unreadDms, mentions }: InboxLists) {
  const [open, setOpen] = useState(false)
  const pendingKeyRef = useRef<string | null>(null)

  // Toggling the popover (open OR close, by user or by us) clears any pending
  // marker so a stale key can never fire a surprise close later.
  const onOpenChange = useCallback((next: boolean) => {
    pendingKeyRef.current = null
    setOpen(next)
  }, [])

  // Call when a row is opened AND navigation happens.
  const watchItem = useCallback((key: string) => {
    pendingKeyRef.current = key
  }, [])

  // When the watched row leaves the list, collapse. Keyed off the list arrays
  // (stable references from React Query) so it re-checks precisely when the
  // "row disappeared" signal lands, not on every render.
  useEffect(() => {
    const key = pendingKeyRef.current
    if (!open || !key) return
    if (!inboxItemPresent({ unreads, unreadDms, mentions }, key)) {
      pendingKeyRef.current = null
      setOpen(false)
    }
  }, [open, unreads, unreadDms, mentions])

  return { open, onOpenChange, watchItem }
}
