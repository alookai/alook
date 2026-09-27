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
 * Implementation: force a mount fetch, then latch its first settled non-null
 * response in a `useRef`. Cached data retained across an unmount is withheld
 * while that fetch is active; otherwise it could become the new mount's
 * frozen anchor before the server response arrives. All later calls return
 * the ref value, keeping the anchor stable through mid-mount refetches.
 *
 * Cross-mount refresh: `gcTime: 0` normally evicts the cache entry after the
 * consumer unmounts, and `refetchOnMount: "always"` covers a quick remount
 * before that eviction timer runs. The next snapshot therefore comes from
 * the current server response rather than the pre-scroll pointer.
 */
export function useChannelReadStateSnapshot(
  channelId: string | null | undefined,
  canonicalSnapshot?: ChannelReadStateSnapshot,
): {
  snapshot: ChannelReadStateSnapshot | null
  isFetching: boolean
} {
  const query = useQuery<ChannelReadStateSnapshot>({
    queryKey: channelId
      ? communityKeys.channelReadStateSnapshot(channelId)
      : ["community", "channel", "__none__", "read-state-snapshot"],
    queryFn: async ({ signal }) => {
      return apiFetch<ChannelReadStateSnapshot>(
        `/api/community/channels/${channelId}/read-state`,
        { signal },
      )
    },
    enabled: !!channelId,
    staleTime: Infinity,
    // Schedule eviction when the last observer unmounts. A rapid remount can
    // still beat that timer, so the forced refetch and settled-data latch are
    // both required for a current read pointer.
    gcTime: 0,
    // A retained or hydrated cache entry must not become the frozen snapshot
    // for this mount. Always refetch; the latch below ignores query data until
    // that request settles.
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    // Snapshot is one-shot; even if TanStack retries a failed fetch, the
    // ref latches only the FIRST resolved value we see.
    retry: 1,
  })

  // Latch the first available snapshot so subsequent renders return a stable
  // reference. A canonical row restored with the message window is a complete
  // warm projection and may render immediately while this query revalidates
  // in the background. Its response updates canonical state for later mounts;
  // it must never walk this mount's divider.
  //
  // Reset on channelId change — a new channel mount is a new snapshot
  // lifecycle. Must reset synchronously during render so the returned
  // snapshot never belongs to the previous channel.
  const snapshotRef = useRef<ChannelReadStateSnapshot | null>(null)
  const lastChannelIdRef = useRef<string | null | undefined>(channelId)
  /* eslint-disable react-hooks/refs -- sync channel switch reset; see hook tests */
  if (lastChannelIdRef.current !== channelId) {
    snapshotRef.current = null
    lastChannelIdRef.current = channelId
  }
  if (snapshotRef.current === null && canonicalSnapshot) {
    snapshotRef.current = canonicalSnapshot
  }
  /* eslint-enable react-hooks/refs */
  useEffect(() => {
    if (snapshotRef.current !== null) return
    if (query.isFetching) return
    if (query.data) snapshotRef.current = query.data
  }, [query.data, query.isFetching])

  /* eslint-disable react-hooks/refs -- latched snapshot read; see hook tests */
  return {
    snapshot: snapshotRef.current ?? (!query.isFetching ? (query.data ?? null) : null),
    isFetching: snapshotRef.current === null && query.isFetching,
  }
  /* eslint-enable react-hooks/refs */
}
