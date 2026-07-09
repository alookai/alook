"use client"

import {
  useInfiniteQuery,
  useQueryClient,
  type UseInfiniteQueryResult,
  type InfiniteData,
} from "@tanstack/react-query"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import type { Msg } from "@/components/community/_types"
import { flushPendingReads } from "@/hooks/community/mutations/messages"

/**
 * Fetches paginated messages for a community channel.
 *
 * Bi-directional after A2: an anchor window centred on the viewer's
 * `lastReadMessageId` (or a jump-target id) may sit in the middle of history,
 * so pagination now flows both up (older, via `fetchOlder`) and down (newer,
 * via `fetchNewer`). Legacy "newest page" behaviour is preserved for the case
 * where no anchor is provided.
 *
 * TanStack convention: `fetchNextPage` appends to `pages`, `fetchPreviousPage`
 * prepends. We map "next" → older (further into the past = further along the
 * infinite scroll direction) and "previous" → newer, then expose them under
 * `fetchOlder` / `fetchNewer` so callers never see the TanStack naming.
 *
 * The query key nests under `communityKeys.channelMessages(channelId)` so a
 * single `invalidateQueries({ queryKey: communityKeys.channelMessages(id) })`
 * refreshes every page in one call.
 */
export type MessagesPage = {
  messages: Msg[]
  latestSeq?: number
  // Anchor / since mode
  hasMoreOlder?: boolean
  hasMoreNewer?: boolean
  olderCursor?: string
  newerCursor?: string
  // Legacy (newest + older continuation) mode
  hasMore?: boolean
  cursor?: string
}

// Discriminated pageParam. The queryFn dispatches on `mode` — the URL param
// map is: newest → no param, older → cursor, newer/since → since, anchor →
// anchor. Since is reserved for future direct catch-up (Commit C); A2 never
// fires it, but the type covers it so the server contract stays honest.
export type MessagesPageParam =
  | { mode: "newest" }
  | { mode: "anchor"; anchor: string }
  | { mode: "since"; since: string }
  | { mode: "older"; cursor: string }
  | { mode: "newer"; cursor: string }

function buildMessagesUrl(base: string, pageParam: MessagesPageParam): string {
  const params = new URLSearchParams()
  switch (pageParam.mode) {
    case "newest":
      break
    case "older":
      params.set("cursor", pageParam.cursor)
      break
    case "newer":
      params.set("since", pageParam.cursor)
      break
    case "since":
      params.set("since", pageParam.since)
      break
    case "anchor":
      params.set("anchor", pageParam.anchor)
      break
  }
  const qs = params.toString()
  return qs ? `${base}?${qs}` : base
}

export const channelMessagesQueryFn =
  (channelId: string) =>
  async ({ pageParam }: { pageParam: MessagesPageParam }): Promise<MessagesPage> => {
    return apiFetch<MessagesPage>(
      buildMessagesUrl(`/api/community/channels/${channelId}/messages`, pageParam),
    )
  }

export const dmMessagesQueryFn =
  (dmId: string) =>
  async ({ pageParam }: { pageParam: MessagesPageParam }): Promise<MessagesPage> => {
    return apiFetch<MessagesPage>(
      buildMessagesUrl(`/api/community/dm/${dmId}/messages`, pageParam),
    )
  }

/**
 * Merge all pages into a single chronological ASC list, deduping by id.
 * Extracted so tests can drive the reducer without spinning up a full hook.
 *
 * Pages arrive out of order — the initial page may be an anchor window in the
 * middle of history, then older pages append below and newer pages prepend
 * above. Sort once at the end so the visible order is always correct
 * regardless of fetch sequence. Bounded by loaded rows (typically < 500) —
 * O(n log n) is fine here.
 */
export function mergeMessagesPages(pages: MessagesPage[]): Msg[] {
  const all: Msg[] = []
  for (const p of pages) {
    for (const m of p.messages) all.push(m)
  }
  all.sort((a, b) => {
    const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0
    const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0
    if (ta !== tb) return ta - tb
    if (a.id < b.id) return -1
    if (a.id > b.id) return 1
    return 0
  })
  const seen = new Set<string>()
  const out: Msg[] = []
  for (const m of all) {
    if (seen.has(m.id)) continue
    seen.add(m.id)
    out.push(m)
  }
  return out
}

// Fix 4 window: how stale a hydrated cache may be before a mount fires an
// invalidate. Short enough that a returning tab picks up fresh data on the
// first paint, long enough that rapid channel switching within a single
// session doesn't churn the network — the reconnect handler in
// `useCommunityWs` covers longer offline gaps on its own.
const STALE_HYDRATED_CACHE_MS = 30_000

type PageCache = InfiniteData<MessagesPage, MessagesPageParam>

type MessagesReturn = UseInfiniteQueryResult<PageCache, Error> & {
  messages: Msg[]
  latestSeq: number
  hasMoreOlder: boolean
  hasMoreNewer: boolean
  isFetchingOlder: boolean
  isFetchingNewer: boolean
  fetchOlder: () => void
  fetchNewer: () => void
  jumpToPresent: () => void
  // Legacy alias — mirrors `hasMoreOlder`. Kept so consumers not yet migrated
  // off the older-only API still compile until every call site is updated.
  hasMore: boolean
}

type MessagesOpts = {
  /**
   * Anchor for the initial fetch. Undefined = read-state not resolved yet;
   * the hook stays disabled until this becomes a value or `null`. `null`
   * = no anchor (never read / DM without snapshot); goes straight to
   * newest-mode. A string = fetch `?anchor=<id>` on the first page.
   */
  lastReadMessageId?: string | null
}

// Shared pagination + reducer used by both channel and DM hooks. Kept inline
// as a hook because both variants need the same TanStack setup — factoring
// out a plain function would leak query internals; a hook stays clean.
function useMessagesInner(
  scopeId: string | null,
  queryKey: readonly unknown[],
  queryFn: ({ pageParam }: { pageParam: MessagesPageParam }) => Promise<MessagesPage>,
  opts: MessagesOpts | undefined,
): MessagesReturn {
  const queryClient = useQueryClient()

  // `undefined` = anchor snapshot is still resolving; gate the query on it
  // being a resolved value (string OR null). Owners without a snapshot
  // (currently DM) pass `null` explicitly.
  const anchorResolved = opts?.lastReadMessageId !== undefined
  const anchorId = opts?.lastReadMessageId ?? null
  const enabled = !!scopeId && anchorResolved

  // Force-newest override — flipped by `jumpToPresent`. Held in state so
  // React re-renders with the new options before the reset fires (see the
  // useEffect below). Cleared once the first newest page arrives.
  const [forceNewest, setForceNewest] = useState(false)

  const initialPageParam = useMemo<MessagesPageParam>(() => {
    if (forceNewest) return { mode: "newest" }
    if (anchorId) return { mode: "anchor", anchor: anchorId }
    return { mode: "newest" }
  }, [forceNewest, anchorId])

  const query = useInfiniteQuery<
    MessagesPage,
    Error,
    PageCache,
    typeof queryKey,
    MessagesPageParam
  >({
    queryKey,
    queryFn: enabled
      ? queryFn
      : () => Promise.reject(new Error("disabled")),
    initialPageParam,
    // "next" = older side. `fetchNextPage` appends to `data.pages`, so the
    // LAST entry in `pages` is the oldest window we've loaded — that's the
    // page whose cursor gets consulted for the next older fetch.
    getNextPageParam: (last) => {
      const has = last.hasMoreOlder ?? last.hasMore ?? false
      if (!has) return undefined
      const cursor = last.olderCursor ?? last.cursor
      if (!cursor) return undefined
      return { mode: "older", cursor }
    },
    // "previous" = newer side. `fetchPreviousPage` prepends to `data.pages`,
    // so the FIRST entry is the newest window loaded. In legacy (newest)
    // mode `hasMoreNewer` is absent → falsy → no previous page.
    getPreviousPageParam: (first) => {
      if (!first.hasMoreNewer) return undefined
      const cursor = first.newerCursor
      if (!cursor) return undefined
      return { mode: "newer", cursor }
    },
    enabled,
  })

  // Flush any pending mark-read on scope switch / unmount so the 500ms
  // debounce doesn't strand the last-read pointer when the user hops
  // scopes mid-window. Same as the pre-A2 behaviour.
  useEffect(() => {
    if (!scopeId) return
    return () => {
      flushPendingReads()
    }
  }, [scopeId])

  // Two-phase reset: setForceNewest triggers a render that updates
  // `initialPageParam` to newest. THIS effect fires on that render and
  // actually clears the query, so the refetch reads the newest-mode options
  // rather than the pre-flip anchor options.
  useEffect(() => {
    if (!forceNewest) return
    void queryClient.resetQueries({ queryKey })
  }, [forceNewest, queryClient, queryKey])

  // Clear the flag once a newest-shape page lands — anchor pages carry
  // `hasMoreOlder`/`hasMoreNewer`; legacy newest carries `hasMore`. If the
  // first cached page reads as legacy, the jump succeeded.
  useEffect(() => {
    if (!forceNewest) return
    const first = query.data?.pages[0]
    if (!first) return
    const isNewestShape = first.hasMore !== undefined && first.hasMoreOlder === undefined
    if (isNewestShape) setForceNewest(false)
  }, [forceNewest, query.data])

  // Fix 3 — anchor re-validation.
  //
  // When a persisted cache is rehydrated, TanStack uses the cached `pages`
  // even if `initialPageParam` says "anchor at m_42". If m_42 isn't in the
  // hydrated window (e.g. the persisted cache was a newest-tail and the
  // read pointer has since advanced past it), `newDividerBefore` computes
  // to `undefined` and the list snaps to bottom — no NEW divider, wrong
  // position.
  //
  // Detect that shape and reset the query so it refetches under the correct
  // anchor pageParam. Fire exactly once per (scopeId, anchorId) pair via a
  // ref — a subsequent watermark tick that advances lastReadMessageId is a
  // different pair and gets its own single reset opportunity.
  const anchorResetKeyRef = useRef<string | null>(null)
  useEffect(() => {
    if (!enabled) return
    if (!anchorId) return
    if (query.isFetching) return
    if (query.isPending) return
    const pages = query.data?.pages
    if (!pages || pages.length === 0) return
    let messageCount = 0
    let anchorFound = false
    for (const p of pages) {
      messageCount += p.messages.length
      if (!anchorFound) {
        for (const m of p.messages) {
          if (m.id === anchorId) {
            anchorFound = true
            break
          }
        }
      }
    }
    if (messageCount === 0) return
    if (anchorFound) return
    const resetKey = `${scopeId ?? ""}::${anchorId}`
    if (anchorResetKeyRef.current === resetKey) return
    anchorResetKeyRef.current = resetKey
    void queryClient.resetQueries({ queryKey })
  }, [
    enabled,
    anchorId,
    scopeId,
    query.data,
    query.isFetching,
    query.isPending,
    queryClient,
    queryKey,
  ])

  // Fix 4 — staleness invalidate on mount / scope switch ONLY.
  //
  // When the cache is hydrated from IDB, `dataUpdatedAt` reflects the last
  // fetch of the previous session. TanStack won't refetch on mount for
  // infinite queries by default, so the client keeps rendering the stale
  // window even though `latestSeq` on the server may have advanced. On
  // mount, if the hydrated window is older than the freshness window, kick
  // off an invalidation — TanStack re-runs every persisted `pageParam` and
  // the fresh `latestSeq` in the server response drives `unreadCount` and
  // `hasMoreNewer` to the truth without any client bookkeeping.
  //
  // Fires EXACTLY ONCE per scope (channelId / dmId), gated by a scopeId ref.
  // Previously the effect had `query.dataUpdatedAt` in its dep list, which
  // re-evaluated on every fetch complete — including AFTER an optimistic
  // send stayed in-place past 30s of stillness. Any such re-eval could
  // invalidate the cache, refetch server pages, and drop the just-sent
  // (already reconciled) row visually before the WS broadcast caught up.
  // Locking to "one shot per scope" preserves the mount-time invariant
  // (hydrated-and-stale gets refreshed) without ever firing again for the
  // same open scope. WS reconnect + user-initiated navigation cover any
  // subsequent freshness needs.
  const staleCacheCheckedScopeRef = useRef<string | null>(null)
  useEffect(() => {
    if (!enabled) return
    if (!scopeId) return
    if (staleCacheCheckedScopeRef.current === scopeId) return
    if (query.isFetching) return
    if (query.isPending) return
    const updatedAt = query.dataUpdatedAt
    if (!updatedAt) return
    staleCacheCheckedScopeRef.current = scopeId
    if (Date.now() - updatedAt < STALE_HYDRATED_CACHE_MS) return
    void queryClient.invalidateQueries({ queryKey })
  }, [
    enabled,
    scopeId,
    query.dataUpdatedAt,
    query.isFetching,
    query.isPending,
    queryClient,
    queryKey,
  ])

  const messages = useMemo<Msg[]>(() => {
    if (!query.data) return []
    return mergeMessagesPages(query.data.pages)
  }, [query.data])

  const latestSeq = useMemo<number>(() => {
    if (!query.data) return 0
    let max = 0
    for (const p of query.data.pages) {
      const s = p.latestSeq ?? 0
      if (s > max) max = s
    }
    return max
  }, [query.data])

  const pages = query.data?.pages ?? []
  const oldestPage = pages[pages.length - 1]
  const newestPage = pages[0]
  const hasMoreOlder = (oldestPage?.hasMoreOlder ?? oldestPage?.hasMore) ?? false
  const hasMoreNewer = newestPage?.hasMoreNewer ?? false

  // Callbacks depend on `query.*` fields that TanStack refreshes on every
  // internal state change — closing over the whole query object keeps the
  // exhaustive-deps rule happy without spelling every subfield.
  const fetchOlder = useCallback(() => {
    if (!query.hasNextPage) return
    if (query.isFetchingNextPage) return
    void query.fetchNextPage()
  }, [query])

  const fetchNewer = useCallback(() => {
    if (!query.hasPreviousPage) return
    if (query.isFetchingPreviousPage) return
    void query.fetchPreviousPage()
  }, [query])

  const jumpToPresent = useCallback(() => {
    setForceNewest(true)
  }, [])

  return {
    ...query,
    messages,
    latestSeq,
    hasMoreOlder,
    hasMoreNewer,
    isFetchingOlder: query.isFetchingNextPage,
    isFetchingNewer: query.isFetchingPreviousPage,
    fetchOlder,
    fetchNewer,
    jumpToPresent,
    hasMore: hasMoreOlder,
  }
}

/**
 * Hook wrapper around `useInfiniteQuery` for a channel's message stream.
 *
 * Pass `null` for "no active channel" — the query stays disabled. DM views
 * should call `useDmMessages` instead of this hook.
 */
export function useMessages(
  channelId: string | null,
  opts?: MessagesOpts,
): MessagesReturn {
  const queryKey = communityKeys.channelMessages(channelId ?? "__none__")
  return useMessagesInner(
    channelId,
    queryKey,
    channelMessagesQueryFn(channelId ?? "__none__"),
    opts,
  )
}

/**
 * DM-scoped sibling of `useMessages`. Same pagination shape, different route.
 */
export function useDmMessages(
  dmId: string | null,
  opts?: MessagesOpts,
): MessagesReturn {
  const queryKey = communityKeys.dmMessages(dmId ?? "__none__")
  return useMessagesInner(
    dmId,
    queryKey,
    dmMessagesQueryFn(dmId ?? "__none__"),
    opts,
  )
}
