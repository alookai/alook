"use client"

import { useEffect, useRef, useState } from "react"
import { useQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import type { ChannelReadStateSnapshot } from "./use-channel-read-state"
import type { MessagesPage, MessagesPageParam } from "./use-messages"

// Response of GET /api/community/channels/:id/bootstrap — the read pointer plus
// the initial (anchor-centered or newest) message window, in one round-trip.
// See plans/community-switch-perf-optimization.md (WS2).
type ChannelBootstrapResponse = {
  readState: ChannelReadStateSnapshot
  anchorMode: "anchor" | "newest"
  anchorMessageId: string | null
} & MessagesPage

/**
 * Build the `InfiniteData` seed for `channelMessages(id)` from a bootstrap
 * response. Pure + exported so the seed shape (mandatory `pageParams`, anchor
 * vs newest mode, anchor-mode envelope) is unit-tested without a render loop.
 */
export function buildMessagesSeed(
  data: ChannelBootstrapResponse,
): InfiniteData<MessagesPage, MessagesPageParam> {
  const page: MessagesPage = {
    messages: data.messages as MessagesPage["messages"],
    latestSeq: data.latestSeq,
    hasMoreOlder: data.hasMoreOlder,
    hasMoreNewer: data.hasMoreNewer,
    olderCursor: data.olderCursor,
    newerCursor: data.newerCursor,
  }
  const pageParam: MessagesPageParam =
    data.anchorMode === "anchor" && data.anchorMessageId
      ? { mode: "anchor", anchor: data.anchorMessageId }
      : { mode: "newest" }
  return { pages: [page], pageParams: [pageParam] }
}

/**
 * De-serialized channel open. Replaces the read-state → gated messages serial
 * chain on the INITIAL window: one request seeds both the read-state snapshot
 * cache and the `channelMessages` infinite-query cache, so `useMessages` can
 * paginate + WS-patch from the seed without a second round-trip.
 *
 * Skipped when `jumpTargetId` is set — a jump-open must anchor on the jump
 * target, not the read pointer, and the seed-then-trust mechanism would
 * otherwise override it (the page keeps the legacy read-state + ?anchor=jump
 * path in that case).
 *
 * Freeze-once: the returned `readState` latches the first resolved value for
 * the mount (like `useChannelReadStateSnapshot`'s `snapshotRef`), so a refetch
 * returning an advanced pointer never walks the "New" divider down the list.
 */
export function useChannelBootstrap(
  channelId: string | null | undefined,
  opts?: { enabled?: boolean },
): {
  readState: ChannelReadStateSnapshot | null
  isFetching: boolean
  isReady: boolean
} {
  const queryClient = useQueryClient()
  const enabled = !!channelId && (opts?.enabled ?? true)

  const query = useQuery<ChannelBootstrapResponse>({
    queryKey: channelId
      ? communityKeys.channelBootstrap(channelId)
      : ["community", "channel", "__none__", "bootstrap"],
    queryFn: async () => {
      const data = await apiFetch<ChannelBootstrapResponse>(
        `/api/community/channels/${channelId}/bootstrap`,
      )
      // Seed the message infinite-query cache so `useMessages` mounts on a
      // trusted first window instead of refetching it. The pageParams entry is
      // mandatory: getNextPageParam/getPreviousPageParam + anchor-revalidation
      // read it. Newest fallback seeds a `{ mode: "newest" }` param.
      queryClient.setQueryData(communityKeys.channelMessages(channelId!), buildMessagesSeed(data))
      // Seed the read-state snapshot cache too, so any consumer of that key
      // reads the same pointer without its own network fetch.
      queryClient.setQueryData(
        communityKeys.channelReadStateSnapshot(channelId!),
        data.readState,
      )
      return data
    },
    enabled,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: 1,
  })

  // Freeze the first resolved read pointer for the mount (see hook doc).
  const readRef = useRef<ChannelReadStateSnapshot | null>(null)
  const lastChannelIdRef = useRef<string | null | undefined>(channelId)
  /* eslint-disable react-hooks/refs -- sync channel-switch reset, mirrors use-channel-read-state */
  if (lastChannelIdRef.current !== channelId) {
    readRef.current = null
    lastChannelIdRef.current = channelId
  }
  /* eslint-enable react-hooks/refs */
  const [, force] = useState(0)
  useEffect(() => {
    if (readRef.current !== null) return
    if (query.data?.readState) {
      readRef.current = query.data.readState
      force((n) => n + 1)
    }
  }, [query.data])

  /* eslint-disable react-hooks/refs -- latched read pointer */
  return {
    readState: readRef.current ?? query.data?.readState ?? null,
    isFetching: query.isFetching,
    isReady: query.isSuccess,
  }
  /* eslint-enable react-hooks/refs */
}
