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
  // Numeric equivalent of `lastReadMessageId` — the seq of the row that
  // pointer refers to. Server returns `0` when the viewer has never read
  // this channel; consumers subtract from `latestSeq` for the unread-count
  // pill without needing to walk loaded rows.
  lastReadSeq: number
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
 * `staleTime: Infinity` + `snapshotRef` combo keeps the anchor frozen for
 * the entire mount regardless of what TanStack does mid-mount.
 *
 * Cross-mount refresh: `gcTime: 0` evicts the cache entry the instant the
 * consumer unmounts. The next mount finds an empty cache and MUST refetch
 * from the server — otherwise the divider re-anchors to the pre-scroll
 * position even after the IntersectionObserver has advanced the read row.
 * Note: `refetchOnMount: true` is NOT enough here — with `staleTime:
 * Infinity`, TanStack considers cached data fresh and skips the refetch.
 * `gcTime: 0` is the only reliable path to a genuine cross-mount reload.
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
    // Evict the cache entry the moment the last observer unmounts. Combined
    // with the fresh useRef on each mount, this guarantees revisiting a
    // channel fires a real network fetch instead of replaying the stale
    // pre-scroll pointer — otherwise the "New" divider re-appears at the
    // old position because TanStack's `staleTime: Infinity` treats cached
    // data as fresh and refuses to refetch on remount.
    gcTime: 0,
    // Belt-and-braces alongside `gcTime: 0`. If a persisted or hydrated
    // snapshot ever lands in the cache (e.g. a future feature flips this
    // key back into the persist allowlist), `refetchOnMount: "always"` still
    // fires a network fetch on mount. The `snapshotRef` below latches only
    // the FIRST non-null resolution, so the refetched value is what gets
    // frozen — the freeze semantics are preserved.
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    // Snapshot is one-shot; even if TanStack retries a failed fetch, the
    // ref latches only the FIRST resolved value we see.
    retry: 1,
  })

  // Latch the first resolved snapshot so subsequent renders return a stable
  // reference. Reset on channelId change — a new channel mount is a new
  // snapshot lifecycle. Must reset synchronously during render so the
  // returned snapshot never belongs to the previous channel.
  const snapshotRef = useRef<ChannelReadStateSnapshot | null>(null)
  const lastChannelIdRef = useRef<string | null | undefined>(channelId)
  /* eslint-disable react-hooks/refs -- sync channel switch reset; see hook tests */
  if (lastChannelIdRef.current !== channelId) {
    snapshotRef.current = null
    lastChannelIdRef.current = channelId
  }
  /* eslint-enable react-hooks/refs */
  useEffect(() => {
    if (snapshotRef.current !== null) return
    if (query.data) snapshotRef.current = query.data
  }, [query.data])

  /* eslint-disable react-hooks/refs -- latched snapshot read; see hook tests */
  return {
    snapshot: snapshotRef.current ?? (query.data ?? null),
    isFetching: query.isFetching,
  }
  /* eslint-enable react-hooks/refs */
}
