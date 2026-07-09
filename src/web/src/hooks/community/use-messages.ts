"use client"

import {
  useInfiniteQuery,
  type UseInfiniteQueryResult,
  type InfiniteData,
} from "@tanstack/react-query"
import { useEffect, useMemo } from "react"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import type { Msg } from "@/components/community/_types"
import { flushPendingReads } from "@/hooks/community/mutations/messages"

/**
 * Fetches paginated messages for a community channel.
 *
 * Uses `useInfiniteQuery` with a cursor pageParam matching the server's
 * `?cursor=` param (format `createdAt|id`, materialised by
 * `lib/community/messages.ts:parseCursor`). Each fetched page prepends
 * older-than-cursor rows before the current messages; consumers concatenate
 * `data.pages.flatMap(p => p.messages)` in the order the server returned
 * (already reversed to chronological ascending inside the route).
 *
 * The query key nests under `communityKeys.channelMessages(channelId)` so a
 * single `invalidateQueries({ queryKey: communityKeys.channelMessages(id) })`
 * refreshes every page in one call.
 */
export type MessagesPage = {
  messages: Msg[]
  hasMore: boolean
  cursor?: string
}

export const channelMessagesQueryFn =
  (channelId: string) =>
  async ({ pageParam }: { pageParam: string | null | undefined }): Promise<MessagesPage> => {
    const params = new URLSearchParams()
    if (pageParam) params.set("cursor", pageParam)
    const url = `/api/community/channels/${channelId}/messages${params.toString() ? `?${params}` : ""}`
    return apiFetch<MessagesPage>(url)
  }

export const dmMessagesQueryFn =
  (dmId: string) =>
  async ({ pageParam }: { pageParam: string | null | undefined }): Promise<MessagesPage> => {
    const params = new URLSearchParams()
    if (pageParam) params.set("cursor", pageParam)
    const url = `/api/community/dm/${dmId}/messages${params.toString() ? `?${params}` : ""}`
    return apiFetch<MessagesPage>(url)
  }

type MessagesReturn = UseInfiniteQueryResult<InfiniteData<MessagesPage>, Error> & {
  messages: Msg[]
  hasMore: boolean
  fetchOlder: () => void
  isFetchingOlder: boolean
}

/**
 * Hook wrapper around `useInfiniteQuery` for a channel's message stream.
 *
 * Pass `null` for "no active channel" — the query stays disabled. DM views
 * should call `useDmMessages` instead of this hook.
 */
export function useMessages(channelId: string | null): MessagesReturn {
  const enabled = !!channelId
  const queryKey = communityKeys.channelMessages(channelId ?? "__none__")
  const query = useInfiniteQuery<
    MessagesPage,
    Error,
    InfiniteData<MessagesPage>,
    typeof queryKey,
    string | null | undefined
  >({
    queryKey,
    queryFn: enabled
      ? channelMessagesQueryFn(channelId!)
      : (() => Promise.reject(new Error("disabled"))),
    initialPageParam: null,
    getNextPageParam: (last) => (last.hasMore ? (last.cursor ?? null) : undefined),
    enabled,
  })

  // Flush any pending mark-channel-read on channel switch / unmount so the
  // 500ms debounce doesn't strand the last-read pointer when the user hops
  // channels mid-window.
  useEffect(() => {
    if (!channelId) return
    return () => {
      flushPendingReads()
    }
  }, [channelId])

  const messages = useMemo<Msg[]>(() => {
    if (!query.data) return []
    // Pages are returned newest-first cursor-wise; the server reverses inside
    // each page so each page's messages are already ASC. Concatenating in
    // page order gives chronological ASC across the whole stream — matches
    // what the context previously produced by prepending older rows.
    const out: Msg[] = []
    for (let i = query.data.pages.length - 1; i >= 0; i--) {
      out.push(...query.data.pages[i].messages)
    }
    return out
  }, [query.data])

  const lastPage = query.data?.pages[query.data.pages.length - 1]
  const hasMore = lastPage?.hasMore ?? false

  return {
    ...query,
    messages,
    hasMore,
    fetchOlder: () => {
      if (!query.hasNextPage) return
      if (query.isFetchingNextPage) return
      void query.fetchNextPage()
    },
    isFetchingOlder: query.isFetchingNextPage,
  }
}

/**
 * DM-scoped sibling of `useMessages`. Same pagination shape, different route.
 */
export function useDmMessages(dmId: string | null): MessagesReturn {
  const enabled = !!dmId
  const queryKey = communityKeys.dmMessages(dmId ?? "__none__")
  const query = useInfiniteQuery<
    MessagesPage,
    Error,
    InfiniteData<MessagesPage>,
    typeof queryKey,
    string | null | undefined
  >({
    queryKey,
    queryFn: enabled
      ? dmMessagesQueryFn(dmId!)
      : (() => Promise.reject(new Error("disabled"))),
    initialPageParam: null,
    getNextPageParam: (last) => (last.hasMore ? (last.cursor ?? null) : undefined),
    enabled,
  })

  const messages = useMemo<Msg[]>(() => {
    if (!query.data) return []
    const out: Msg[] = []
    for (let i = query.data.pages.length - 1; i >= 0; i--) {
      out.push(...query.data.pages[i].messages)
    }
    return out
  }, [query.data])

  const lastPage = query.data?.pages[query.data.pages.length - 1]
  const hasMore = lastPage?.hasMore ?? false

  return {
    ...query,
    messages,
    hasMore,
    fetchOlder: () => {
      if (!query.hasNextPage) return
      if (query.isFetchingNextPage) return
      void query.fetchNextPage()
    },
    isFetchingOlder: query.isFetchingNextPage,
  }
}
