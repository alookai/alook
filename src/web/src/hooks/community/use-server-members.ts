"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  useInfiniteQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query"
import { apiFetch, toastApiError } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import type { Member } from "@/lib/community/models/people"
import type {
  CommunityMemberJoin,
  CommunityMemberLeave,
  CommunityMemberUpdate,
  CommunityRole,
} from "@alook/shared"
import { avatarInitial } from "@/lib/community/avatar"

// Debounce window for the search input (ms). Kept short — the endpoint is
// prefix-only and cheap, but avoid a fetch per keystroke.
export const SEARCH_DEBOUNCE_MS = 200

// ── Pure reducers (exported for direct unit tests) ────────────────────────────
//
// These implement the WS-event insertion strategy documented in
// `plans/09-members-infinite-scroll.md` §Milestone (b):
//   - MEMBER_JOIN appends at the *tail* only when the last page is loaded
//     (`!hasMore`); otherwise the event is dropped — the joiner will show up
//     once the intervening pages load.
//   - MEMBER_LEAVE filters by userId — no refetch.
//   - MEMBER_UPDATE patches role / nickname in place — no refetch.
//
// Kept as free functions so the tests can exercise them without spinning up a
// React render harness (this repo has no jsdom / testing-library setup).
export function applyJoinEvent(
  prev: Member[],
  event: CommunityMemberJoin,
  hasMore: boolean,
): Member[] {
  if (hasMore) return prev
  if (prev.some((m) => m.userId === event.member.userId)) return prev
  return [
    ...prev,
    {
      id: event.member.id,
      userId: event.member.userId,
      name: event.member.name,
      discriminator: event.member.discriminator,
      avatar: event.member.avatar ?? avatarInitial(event.member.name),
      status: "online",
      sub: "",
      role: event.member.role as CommunityRole,
    },
  ]
}

export function applyLeaveEvent(prev: Member[], event: CommunityMemberLeave): Member[] {
  return prev.filter((m) => m.userId !== event.userId)
}

export function applyUpdateEvent(prev: Member[], event: CommunityMemberUpdate): Member[] {
  return prev.map((m) => {
    if (m.id !== event.memberId) return m
    return {
      ...m,
      ...(event.changes.role ? { role: event.changes.role as CommunityRole } : {}),
      ...(event.changes.nickname !== undefined ? { name: event.changes.nickname ?? m.name } : {}),
    }
  })
}

// ── Envelope + query-fn shapes ──────────────────────────────────────────────

export type MembersEnvelope = {
  members: Member[]
  hasMore: boolean
  cursor?: string
  limit: number
  total: number
}

type SearchEnvelope = {
  members: Member[]
  limit: number
}

// Exported so the tests can drive the query function against a mocked
// apiFetch without going through React.
export const membersPageQueryFn =
  (serverId: string) =>
    async ({ pageParam }: { pageParam: string | null | undefined }): Promise<MembersEnvelope> => {
      const params = new URLSearchParams()
      if (pageParam) params.set("cursor", pageParam)
      const url = `/api/community/servers/${serverId}/members${params.toString() ? `?${params}` : ""}`
      return apiFetch<MembersEnvelope>(url)
    }

// ── Cache mutation helpers (also used by the WS handler in Step 3) ──────────

type MembersPageCache = InfiniteData<MembersEnvelope>

/**
 * Apply a MEMBER_JOIN event to the cached pages.
 *
 * Appends the joiner to the last cached page only when the last page is
 * already loaded (`hasMore=false`) — otherwise the joiner belongs on an
 * unloaded page and appending would produce a stale duplicate once that page
 * arrives. Either way, the server-wide `total` bumps on every page so the
 * header count stays accurate.
 *
 * Dedup is by `userId` across every cached page: a re-delivered event whose
 * subject is already loaded is treated as a no-op (no member append, no
 * total bump). Returns the same reference in that case so React-Query bails
 * out of a re-render.
 */
// `total` should read the same across every cached page — it's a per-server
// count, not a per-page tally. The routes populate it identically on each
// paged fetch. Every add/remove event bumps `total` exactly once, regardless
// of which page the target lives on. Dedup for join is by `userId` across all
// pages; for leave/kick, the server contract is that each event fires once
// per membership change, so unconditional decrement stays correct even when
// the target sits on an unloaded page.
function withNormalizedTotal(
  pages: MembersEnvelope[],
  delta: number,
): MembersEnvelope[] {
  if (delta === 0) return pages
  return pages.map((p) => ({ ...p, total: Math.max(0, p.total + delta) }))
}

export function patchCacheJoin(
  cache: MembersPageCache | undefined,
  event: CommunityMemberJoin,
): MembersPageCache | undefined {
  if (!cache) return cache
  // Dedup across every cached page — a re-delivered join must not double the
  // total. If they're already loaded somewhere, treat this as a re-delivery.
  for (const p of cache.pages) {
    if (p.members.some((m) => m.userId === event.member.userId)) return cache
  }
  const lastIdx = cache.pages.length - 1
  const lastPage = cache.pages[lastIdx]
  if (!lastPage) return cache
  const hasMore = lastPage.hasMore
  // Even if we can't append (hasMore=true means the joiner belongs on an
  // unloaded page), still bump total so the header reads accurately.
  if (hasMore) {
    return { ...cache, pages: withNormalizedTotal(cache.pages, +1) }
  }
  const appended = applyJoinEvent(lastPage.members, event, false)
  const nextPages = [...cache.pages]
  nextPages[lastIdx] = { ...lastPage, members: appended }
  return { ...cache, pages: withNormalizedTotal(nextPages, +1) }
}

export function patchCacheLeave(
  cache: MembersPageCache | undefined,
  event: CommunityMemberLeave,
): MembersPageCache | undefined {
  if (!cache) return cache
  const nextPages = cache.pages.map((p) => {
    const filtered = p.members.filter((m) => m.userId !== event.userId)
    if (filtered.length === p.members.length) return p
    return { ...p, members: filtered }
  })
  // Always decrement — the leaver may live on an unloaded page. WS delivers
  // each event exactly once per membership change, so this is idempotent by
  // contract.
  return { ...cache, pages: withNormalizedTotal(nextPages, -1) }
}

export function patchCacheUpdate(
  cache: MembersPageCache | undefined,
  event: CommunityMemberUpdate,
): MembersPageCache | undefined {
  if (!cache) return cache
  const nextPages = cache.pages.map((p) => ({
    ...p,
    members: applyUpdateEvent(p.members, event),
  }))
  return { ...cache, pages: nextPages }
}

export function patchCacheKick(
  cache: MembersPageCache | undefined,
  memberId: string,
): MembersPageCache | undefined {
  if (!cache) return cache
  const nextPages = cache.pages.map((p) => {
    const filtered = p.members.filter((m) => m.id !== memberId)
    if (filtered.length === p.members.length) return p
    return { ...p, members: filtered }
  })
  // Always decrement — the kicked member may live on an unloaded page.
  return { ...cache, pages: withNormalizedTotal(nextPages, -1) }
}

export function patchCacheRole(
  cache: MembersPageCache | undefined,
  memberId: string,
  role: CommunityRole,
): MembersPageCache | undefined {
  if (!cache) return cache
  const nextPages = cache.pages.map((p) => ({
    ...p,
    members: p.members.map((m) => (m.id === memberId ? { ...m, role } : m)),
  }))
  return { ...cache, pages: nextPages }
}

// ── Overlay event bus ───────────────────────────────────────────────────────
//
// The paged cache lives in TanStack Query and is patched directly by the
// mutations. The *search overlay* (results of the /members/search endpoint)
// lives in local state inside `useServerMembers`, so mutations that only touch
// the paged cache would leave a stale row visible when the user has an active
// search.
//
// The bus below lets mutations broadcast overlay-affecting events without
// coupling to the hook instance. `useServerMembers` subscribes and mirror-
// patches its search overlay state; if there's no active search the events
// are a no-op.
export type MemberOverlayEvent =
  | { type: "kick"; serverId: string; memberId: string }
  | { type: "role"; serverId: string; memberId: string; role: CommunityRole }
  | { type: "update"; serverId: string; event: CommunityMemberUpdate }
  | { type: "leave"; serverId: string; userId: string }
  | { type: "refresh"; serverId: string }

const memberOverlayBus =
  typeof EventTarget !== "undefined" ? new EventTarget() : null

const MEMBER_OVERLAY_EVENT = "member-overlay"

export function dispatchMemberOverlayEvent(ev: MemberOverlayEvent): void {
  if (!memberOverlayBus) return
  memberOverlayBus.dispatchEvent(
    new CustomEvent<MemberOverlayEvent>(MEMBER_OVERLAY_EVENT, { detail: ev }),
  )
}

export function subscribeMemberOverlayEvents(
  listener: (ev: MemberOverlayEvent) => void,
): () => void {
  if (!memberOverlayBus) return () => { }
  const handler = (e: Event) => {
    const detail = (e as CustomEvent<MemberOverlayEvent>).detail
    if (detail) listener(detail)
  }
  memberOverlayBus.addEventListener(MEMBER_OVERLAY_EVENT, handler)
  return () => memberOverlayBus.removeEventListener(MEMBER_OVERLAY_EVENT, handler)
}

// ── Public hook API ─────────────────────────────────────────────────────────

export type UseServerMembers = {
  members: Member[]
  loading: boolean
  loadingMore: boolean
  hasMore: boolean
  total: number
  isSearching: boolean
  loadMore: () => void
  reset: () => void
  refresh: () => void
  searchMembers: (q: string) => void
  // Optimistic-UI hooks for the caller's role/kick mutations. The server
  // fans out MEMBER_UPDATE / MEMBER_LEAVE on success; these keep the local
  // view in sync during the in-flight window.
  applyRoleChange: (memberId: string, role: CommunityRole) => void
  applyKick: (memberId: string) => void
}

/**
 * Paginated + virtualized-friendly member state for a single community server.
 *
 * Two view modes:
 * - "paged": pages live in the TanStack Query cache keyed under
 *   `communityKeys.members(serverId)`. `loadMore()` calls `fetchNextPage`.
 * - "search": bypasses the cache — search results live in local state
 *   because the search endpoint is a different route with its own semantics
 *   (no pagination, no cursor) and we don't want to blow away cursor state
 *   when the user starts typing.
 *
 * WS events patch the shared paged cache in `community-ws/membership-events`
 * and notify the overlay bus above. Optimistic mutations use the same cache
 * helpers. Search-view state is patched or re-fetched in parallel so it
 * cannot diverge from the paged view.
 */
export function useServerMembers(serverId: string | null): UseServerMembers {
  const enabled = !!serverId
  // `communityKeys.members(...)` returns a fresh tuple per call, so every
  // `useCallback` below that lists `queryKey` in its deps would churn each
  // render without this memo — cascading a fresh identity into every
  // consumer's dep array. Keep it pinned to the serverId axis.
  const queryKey = useMemo(
    () => communityKeys.members(serverId ?? "__none__"),
    [serverId],
  )
  const queryClient = useQueryClient()

  const infinite = useInfiniteQuery<
    MembersEnvelope,
    Error,
    MembersPageCache,
    typeof queryKey,
    string | null | undefined
  >({
    queryKey,
    // TS satisfies both branches; the `enabled` gate below prevents the
    // disabled query from ever calling this function.
    queryFn: enabled
      ? membersPageQueryFn(serverId!)
      : (() => Promise.reject(new Error("disabled"))),
    initialPageParam: null,
    getNextPageParam: (last) => (last.hasMore ? (last.cursor ?? null) : undefined),
    enabled,
    // WS `member.join/leave/update` live-patch this roster cache, so a remount
    // doesn't need to refetch — this is a once-per-server seed. staleTime:
    // Infinity stops the per-channel-switch refetch. Browser network reconnect
    // and the explicit WS reconnect reconciler both re-seed this query so an
    // event missed during a socket-only gap cannot leave it permanently stale.
    staleTime: Infinity,
    refetchOnReconnect: true,
  })

  // ── Search state ────────────────────────────────────────────────────────
  const [searchOverlay, setSearchOverlay] = useState<{
    serverId: string | null
    members: Member[]
  } | null>(null)
  const activeSearchQuery = useRef("")
  const searchActive = useRef(false)
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Monotonic sequence so out-of-order responses drop old results silently.
  const searchSeq = useRef(0)

  // ── Derived paged state ─────────────────────────────────────────────────
  const pagedMembers = useMemo<Member[]>(() => {
    if (!infinite.data) return []
    return infinite.data.pages.flatMap((p) => p.members)
  }, [infinite.data])

  const lastPage = infinite.data?.pages[infinite.data.pages.length - 1]
  const hasMore = lastPage?.hasMore ?? false
  const total = lastPage?.total ?? 0

  // ── Actions ─────────────────────────────────────────────────────────────
  const loadMore = useCallback(() => {
    if (!infinite.hasNextPage) return
    if (infinite.isFetchingNextPage) return
    void infinite.fetchNextPage()
  }, [infinite])

  const reset = useCallback(() => {
    activeSearchQuery.current = ""
    searchActive.current = false
    setSearchOverlay(null)
    if (searchTimer.current) {
      clearTimeout(searchTimer.current)
      searchTimer.current = null
    }
    searchSeq.current += 1
    if (enabled) {
      queryClient.removeQueries({ queryKey })
    }
  }, [enabled, queryClient, queryKey])

  const refresh = useCallback(() => {
    if (!enabled) return
    void queryClient.invalidateQueries({ queryKey })
  }, [enabled, queryClient, queryKey])

  // When the serverId flips, drop the search overlay (pages are keyed by
  // serverId so they don't need explicit teardown — TanStack Query GC's them
  // and enable=false stops any in-flight fetch).
  useEffect(() => {
    activeSearchQuery.current = ""
    searchActive.current = false
    setSearchOverlay(null)
    if (searchTimer.current) {
      clearTimeout(searchTimer.current)
      searchTimer.current = null
    }
    searchSeq.current += 1
  }, [serverId])

  const runSearch = useCallback(
    async (q: string, seq: number) => {
      if (!enabled) return
      try {
        const params = new URLSearchParams({ q })
        const data = await apiFetch<SearchEnvelope>(
          `/api/community/servers/${serverId}/members/search?${params}`,
        )
        // Guard against out-of-order responses.
        if (searchSeq.current !== seq) return
        setSearchOverlay({ serverId, members: data.members })
      } catch (e) {
        if (searchSeq.current === seq) {
          setSearchOverlay({ serverId, members: [] })
          toastApiError(e, "Search failed")
        }
      }
    },
    [enabled, serverId],
  )

  const searchMembers = useCallback(
    (q: string) => {
      const trimmed = q.trim()
      if (searchTimer.current) {
        clearTimeout(searchTimer.current)
        searchTimer.current = null
      }
      searchSeq.current += 1
      if (trimmed.length === 0) {
        activeSearchQuery.current = ""
        searchActive.current = false
        setSearchOverlay(null)
        return
      }
      activeSearchQuery.current = trimmed
      searchActive.current = true
      const seq = searchSeq.current
      searchTimer.current = setTimeout(() => {
        searchTimer.current = null
        void runSearch(trimmed, seq)
      }, SEARCH_DEBOUNCE_MS)
    },
    [runSearch],
  )

  const applyRoleChange = useCallback(
    (memberId: string, role: CommunityRole) => {
      if (!enabled) return
      queryClient.setQueryData<MembersPageCache | undefined>(queryKey, (cache) =>
        patchCacheRole(cache, memberId, role),
      )
      setSearchOverlay((prev) =>
        prev === null
          ? null
          : {
              ...prev,
              members: prev.members.map((m) =>
                m.id === memberId ? { ...m, role } : m,
              ),
            },
      )
    },
    [enabled, queryClient, queryKey],
  )

  const applyKick = useCallback(
    (memberId: string) => {
      if (!enabled) return
      queryClient.setQueryData<MembersPageCache | undefined>(queryKey, (cache) =>
        patchCacheKick(cache, memberId),
      )
      setSearchOverlay((prev) =>
        prev === null
          ? null
          : { ...prev, members: prev.members.filter((m) => m.id !== memberId) },
      )
    },
    [enabled, queryClient, queryKey],
  )

  // Cleanup pending debounce on unmount so a late fire doesn't paint torn
  // state.
  useEffect(() => {
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current)
    }
  }, [])

  const refreshSearchOverlay = useCallback(() => {
    if (!searchActive.current) return
    const q = activeSearchQuery.current
    if (!q) return
    searchSeq.current += 1
    const seq = searchSeq.current
    void runSearch(q, seq)
  }, [runSearch])

  // Mirror-patch the search overlay from mutation and WS events. Every event
  // carries serverId so a transitioning hook cannot patch results retained
  // from another server. Nickname/join/rollback events re-run the active
  // search because they can change whether a row matches at all.
  useEffect(() => {
    return subscribeMemberOverlayEvents((ev) => {
      if (ev.serverId !== serverId) return
      if (ev.type === "refresh") {
        refreshSearchOverlay()
        return
      }
      if (ev.type === "update" && ev.event.changes.nickname !== undefined) {
        refreshSearchOverlay()
        return
      }
      setSearchOverlay((prev) => {
        if (prev === null) return prev
        switch (ev.type) {
          case "kick":
            return { ...prev, members: prev.members.filter((m) => m.id !== ev.memberId) }
          case "role":
            return {
              ...prev,
              members: prev.members.map((m) =>
                m.id === ev.memberId ? { ...m, role: ev.role } : m,
              ),
            }
          case "update":
            return { ...prev, members: applyUpdateEvent(prev.members, ev.event) }
          case "leave":
            return { ...prev, members: prev.members.filter((m) => m.userId !== ev.userId) }
          default:
            return prev
        }
      })
    })
  }, [refreshSearchOverlay, serverId])

  // A server switch renders before the cleanup effect above runs. Never expose
  // the previous server's local search overlay during that transition frame.
  const isSearchingCurrentServer =
    searchOverlay !== null && searchOverlay.serverId === serverId

  return {
    members: isSearchingCurrentServer ? searchOverlay.members : pagedMembers,
    loading: infinite.isPending && enabled,
    loadingMore: infinite.isFetchingNextPage,
    hasMore,
    total,
    isSearching: isSearchingCurrentServer,
    loadMore,
    reset,
    refresh,
    searchMembers,
    applyRoleChange,
    applyKick,
  }
}
