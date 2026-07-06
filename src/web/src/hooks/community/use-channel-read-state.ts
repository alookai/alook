"use client"

import { useEffect, useRef } from "react"
import { useQuery } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"

/**
 * The channel read-state snapshot returned by
 * `GET /api/community/channels/:id/read-state`. Both fields are `null` when
 * the viewer has never visited the channel.
 */
export type ChannelReadStateSnapshot = {
  lastReadMessageId: string | null
  lastReadAt: string | null
}

/**
 * Once-per-mount snapshot of the viewer's read pointer for a channel.
 *
 * The "New" divider anchors to whichever message sits right after
 * `lastReadAt` at the moment the channel was entered. If we let this value
 * drift as the read pointer advances, the divider would silently walk down
 * the list — the exact opposite of what the user expects. So we snapshot
 * once and never update it during the mount, even if TanStack refetches or
 * a WS event mutates the underlying row.
 *
 * Implementation: fire a normal `useQuery`, then latch the first non-null
 * response in a `useRef`. All subsequent calls return the ref value. The
 * `staleTime: Infinity + refetchOnMount: false` combo means TanStack itself
 * won't tick the cache during this mount, but the ref makes the invariant
 * explicit regardless.
 *
 * Note: this hook does NOT unmount cleanup or invalidate — the next channel
 * mount is a fresh useRef, and the next channel's read row is either fresh
 * from the server or read via `queries.communityReadState.getReadState`
 * afresh. The cache key includes `channelId`, so switching channels reads
 * the other channel's snapshot.
 */
export function useChannelReadStateSnapshot(channelId: string | null | undefined): {
  snapshot: ChannelReadStateSnapshot | null
  isFetching: boolean
} {
  const query = useQuery<ChannelReadStateSnapshot>({
    queryKey: channelId
      ? communityKeys.channelReadStateSnapshot(channelId)
      : ["community", "channel", "__none__", "read-state-snapshot"],
    queryFn: async () => {
      return apiFetch<ChannelReadStateSnapshot>(
        `/api/community/channels/${channelId}/read-state`,
      )
    },
    enabled: !!channelId,
    staleTime: Infinity,
    // The value is anchored to this mount — no refetch on remount, focus,
    // or reconnect. If the user leaves and comes back, a fresh mount fires
    // a new query with a new ref.
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    // Snapshot is one-shot; even if TanStack retries a failed fetch, the
    // ref latches only the FIRST resolved value we see.
    retry: 1,
  })

  // Latch the first resolved snapshot so subsequent renders return a stable
  // reference. Reset on channelId change — a new channel mount is a new
  // snapshot lifecycle.
  const snapshotRef = useRef<ChannelReadStateSnapshot | null>(null)
  const lastChannelIdRef = useRef<string | null | undefined>(channelId)
  if (lastChannelIdRef.current !== channelId) {
    snapshotRef.current = null
    lastChannelIdRef.current = channelId
  }
  useEffect(() => {
    if (snapshotRef.current !== null) return
    if (query.data) snapshotRef.current = query.data
  }, [query.data])

  return {
    snapshot: snapshotRef.current ?? (query.data ?? null),
    isFetching: query.isFetching,
  }
}
