"use client"

import { useLayoutEffect, useMemo } from "react"
import { createStore, useSelector } from "@tanstack/react-store"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { communityRequestOptions } from "@/lib/community/account-cache-lifecycle"
import { captureChannelMetadataToken, isChannelMetadataTokenCurrent, type ChannelMetadataResource } from "./channel-metadata"
import { retryConversationRead, withConversationReadDeadline } from "@/lib/community/conversation-read"
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
 * response in a mount-owned Store. Cached data retained across an unmount is withheld
 * while that fetch is active; otherwise it could become the new mount's
 * frozen anchor before the server response arrives. All later calls return
 * the frozen value, keeping the anchor stable through mid-mount refetches.
 *
 * Cross-mount refresh: `gcTime: 0` normally evicts the cache entry after the
 * consumer unmounts, and `refetchOnMount: "always"` covers a quick remount
 * before that eviction timer runs. The next snapshot therefore comes from
 * the current server response rather than the pre-scroll pointer.
 */
export function useChannelReadStateSnapshot(
  channelId: string | null | undefined,
  canonicalSnapshot?: ChannelReadStateSnapshot,
  kind: "channel" | "dm" = "channel",
): {
  snapshot: ChannelReadStateSnapshot | null
  isFetching: boolean
  error: Error | null
  retrying: boolean
  retry: () => void
} {
  const client = useQueryClient()
  const entry = useMemo(() => createStore({ client, channelId, kind, snapshot: null as ChannelReadStateSnapshot | null }), [client, channelId, kind])
  const frozen = useSelector(entry, (state) => state.snapshot)
  const query = useQuery<ChannelReadStateSnapshot>({
    queryKey: channelId
      ? kind === "dm" ? communityKeys.dmReadStateSnapshot(channelId) : communityKeys.channelReadStateSnapshot(channelId)
      : ["community", kind, "__none__", "read-state-snapshot"],
    queryFn: async ({ client, signal }) => {
      const token = captureChannelMetadataToken(client, channelId!)
      const metadataKey = communityKeys.channelMeta(null, channelId!)
      const metadataQuery = kind === "dm" ? client.getQueryCache().find({ queryKey: metadataKey, exact: true }) : undefined
      const assert = () => { if (signal.aborted || !isChannelMetadataTokenCurrent(token)) throw new DOMException("Stale read-state owner", "AbortError") }
      const updateHistory = (historyVerification?: ChannelMetadataResource["historyVerification"]) => {
        if (metadataQuery && client.getQueryCache().find({ queryKey: metadataKey, exact: true }) === metadataQuery) client.setQueryData<ChannelMetadataResource>(metadataKey, (metadata) => metadata ? { ...metadata, historyVerification } : metadata)
      }
      try {
        const snapshot = await withConversationReadDeadline(signal, (readSignal) => apiFetch<ChannelReadStateSnapshot>(`/api/community/channels/${channelId}/read-state`, communityRequestOptions(client, token, readSignal, assert)))
        assert()
        updateHistory(token)
        return snapshot
      } catch (error) {
        assert()
        if (typeof error === "object" && error !== null && "status" in error && [403, 404].includes(Number(error.status))) updateHistory()
        throw error
      }
    },
    enabled: !!channelId,
    subscribed: !!channelId,
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
    // Store latches only the FIRST resolved value we see.
    retry: retryConversationRead,
    networkMode: "always",
  })

  useLayoutEffect(() => {
    const available = canonicalSnapshot ?? (!query.isFetching ? query.data : undefined)
    if (available) entry.setState((state) => state.snapshot ? state : { ...state, snapshot: available })
  }, [entry, canonicalSnapshot, query.data, query.isFetching])

  return {
    snapshot: frozen ?? canonicalSnapshot ?? (!query.isFetching ? (query.data ?? null) : null),
    isFetching: frozen === null && !canonicalSnapshot && query.isFetching,
    error: query.error,
    retrying: query.isFetching,
    retry: () => { void query.refetch({ cancelRefetch: false }) },
  }
}
