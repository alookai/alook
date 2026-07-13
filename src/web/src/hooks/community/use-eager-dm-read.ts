"use client"

import { useEffect, useRef } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import type { UnreadsResponse } from "./use-inbox"

/**
 * DM sibling of `useEagerChannelRead`. Opening a DM should consume its unread:
 * fire ONE direct mass mark-read PUT (empty body → mark to latest) per mount,
 * gated on the read-state snapshot having latched so the "New" divider keeps
 * the pre-open anchor.
 *
 * Invalidates BOTH `inbox()` and `dms()` — the top-of-app unread badge lives
 * under `inbox()` and the sidebar DM list's `unread` flag under `dms()`. It
 * also optimistically trims the DM out of the `inboxUnreads().dms` array so
 * the popover updates instantly (mirrors `useMarkChannelRead`'s optimistic
 * inbox trim for channels).
 */
export function useEagerDmRead({
  dmId,
  snapshotReady,
}: {
  dmId: string | null | undefined
  snapshotReady: boolean
}) {
  const queryClient = useQueryClient()
  const firedForRef = useRef<string | null>(null)

  useEffect(() => {
    if (!dmId) return
    if (!snapshotReady) return
    if (firedForRef.current === dmId) return
    firedForRef.current = dmId

    // Optimistic trim so the inbox popover drops this DM immediately.
    queryClient.setQueryData<UnreadsResponse>(communityKeys.inboxUnreads(), (prev) =>
      prev ? { ...prev, dms: prev.dms.filter((d) => d.dmConversationId !== dmId) } : prev,
    )

    void apiFetch(`/api/community/dm/${dmId}/read`, { method: "PUT" })
      .then(() => {
        void queryClient.invalidateQueries({ queryKey: communityKeys.inbox() })
        void queryClient.invalidateQueries({ queryKey: communityKeys.dms() })
      })
      .catch(() => {
        // Silent — the watermark / WS invalidate reconciles the inbox anyway.
      })
  }, [dmId, snapshotReady, queryClient])
}
