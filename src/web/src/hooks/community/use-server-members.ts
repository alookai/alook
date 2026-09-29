"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { toastApiError } from "@/lib/api/client"
import {
  apiFetchProfiles,
  communityUserProfilePatch,
} from "@/lib/community/profile-seed"
import type { Member } from "@/lib/community/models/people"
import type {
  CommunityMemberUpdate,
  CommunityRole,
} from "@alook/shared"
import {
  useOptionalCommunityDbRegistry,
  useServerMembersProjection,
} from "@/lib/community-db/projections"

// Debounce window for the search input (ms). Kept short — the endpoint is
// prefix-only and cheap, but avoid a fetch per keystroke.
export const SEARCH_DEBOUNCE_MS = 200

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

type SearchEnvelope = {
  members: Member[]
  limit: number
  hasMore: boolean
  cursor?: string
}

type MemberSearchStatus =
  | "idle"
  | "loading"
  | "loading-more"
  | "ready"
  | "empty"
  | "error"

type MemberSearchState = {
  serverId: string
  query: string
  members: Member[]
  status: Exclude<MemberSearchStatus, "idle">
  cursor?: string
}

export function mergeMemberSearchPage(
  current: Member[],
  incoming: Member[],
): Member[] {
  if (current.length === 0) return incoming
  const seen = new Set(current.map((member) => member.id))
  const additions = incoming.filter((member) => !seen.has(member.id))
  return additions.length === 0 ? current : [...current, ...additions]
}

// ── Overlay event bus ───────────────────────────────────────────────────────
//
// The paged roster lives in the canonical collection. Search results use a
// separate endpoint and local state, so exact collection writes also notify
// this small overlay bus.
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
  searchQuery: string
  searchStatus: MemberSearchStatus
  failed: boolean
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
 * - "paged": a collection descriptor acquires cursor pages and publishes
 *   canonical membership rows. `loadMore()` raises its shared window.
 * - "search": bypasses the cache — paginated search results and their cursor
 *   live in local state because the search endpoint is a different route and
 *   we don't want to overwrite the server-roster page cache while typing.
 *
 * WS events and optimistic mutations write the same collection and notify the
 * overlay bus so search-view state cannot diverge from the paged view.
 */
export function useServerMembers(serverId: string | null): UseServerMembers {
  const enabled = !!serverId
  const registry = useOptionalCommunityDbRegistry()
  const [pageLimit, setPageLimit] = useState(50)
  const paged = useServerMembersProjection(serverId, pageLimit)

  // ── Search state ────────────────────────────────────────────────────────
  const [searchOverlay, setSearchOverlay] = useState<MemberSearchState | null>(null)
  const activeSearchQuery = useRef("")
  const searchActive = useRef(false)
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Monotonic sequence so out-of-order responses drop old results silently.
  const searchSeq = useRef(0)
  const searchPageInFlight = useRef<string | null>(null)

  // ── Actions ─────────────────────────────────────────────────────────────
  const loadMore = useCallback(() => {
    if (!paged.hasMore || paged.loadingMore) return
    setPageLimit((current) => current + 50)
  }, [paged.hasMore, paged.loadingMore])

  const reset = useCallback(() => {
    activeSearchQuery.current = ""
    searchActive.current = false
    setSearchOverlay(null)
    if (searchTimer.current) {
      clearTimeout(searchTimer.current)
      searchTimer.current = null
    }
    searchSeq.current += 1
    setPageLimit(50)
    if (serverId) void registry?.reconcileServerMembers(serverId).catch(() => {})
  }, [registry, serverId])

  const refresh = useCallback(() => {
    if (!serverId) return
    void registry?.reconcileServerMembers(serverId).catch(() => {})
  }, [registry, serverId])

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
    setPageLimit(50)
  }, [serverId])

  const runSearch = useCallback(
    async (q: string, seq: number, cursor?: string) => {
      if (!enabled) return
      const pageKey = `${seq}:${cursor ?? "__first__"}`
      if (searchPageInFlight.current === pageKey) return
      searchPageInFlight.current = pageKey
      try {
        const params = new URLSearchParams({ q })
        if (cursor) params.set("cursor", cursor)
        const data = await apiFetchProfiles<SearchEnvelope>(
          `/api/community/servers/${serverId}/members/search?${params}`,
          (page) => page.members.map((member) =>
            communityUserProfilePatch(member.userId, member)),
        )
        if (searchSeq.current !== seq) return
        setSearchOverlay((current) => {
          const members = cursor
            ? mergeMemberSearchPage(current!.members, data.members)
            : data.members
          return {
            serverId: serverId!,
            query: q,
            members,
            status: data.hasMore && data.cursor
              ? "loading-more"
              : members.length === 0 ? "empty" : "ready",
            cursor: data.hasMore ? data.cursor : undefined,
          }
        })
      } catch (e) {
        if (searchSeq.current === seq) {
          setSearchOverlay((current) => ({
            serverId: serverId!,
            query: q,
            members: current!.members,
            status: "error",
          }))
          toastApiError(e, "Search failed")
        }
      } finally {
        if (searchPageInFlight.current === pageKey) {
          searchPageInFlight.current = null
        }
      }
    },
    [enabled, serverId],
  )

  useEffect(() => {
    if (!searchOverlay || searchOverlay.serverId !== serverId) return
    if (searchOverlay.status !== "loading-more" || !searchOverlay.cursor) return
    const seq = searchSeq.current
    void runSearch(searchOverlay.query, seq, searchOverlay.cursor)
  }, [runSearch, searchOverlay, serverId])

  const searchMembers = useCallback(
    (q: string) => {
      const trimmed = q.trim()
      if (
        trimmed.length > 0
        && searchActive.current
        && activeSearchQuery.current === trimmed
      ) return
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
      setSearchOverlay({
        serverId: serverId!,
        query: trimmed,
        members: [],
        status: "loading",
      })
      searchTimer.current = setTimeout(() => {
        searchTimer.current = null
        void runSearch(trimmed, seq)
      }, SEARCH_DEBOUNCE_MS)
    },
    [runSearch, serverId],
  )

  const applyRoleChange = useCallback(
    (memberId: string, role: CommunityRole) => {
      if (!serverId || !registry) return
      const row = [...registry.collections.serverMemberships.values()].find((membership) => (
        membership.serverId === serverId && membership.memberId === memberId
      ))
      if (row) {
        registry.markServerMembershipChanged(serverId, row.id)
        registry.collections.serverMemberships.utils.writeUpdate({ id: row.id, role })
      }
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
    [registry, serverId],
  )

  const applyKick = useCallback(
    (memberId: string) => {
      if (!serverId || !registry) return
      const row = [...registry.collections.serverMemberships.values()].find((membership) => (
        membership.serverId === serverId && membership.memberId === memberId
      ))
      if (row) {
        registry.markServerMembershipChanged(serverId, row.id, true)
        registry.adjustServerMembersTotal(serverId, -1)
        registry.collections.serverMemberships.utils.writeDelete(row.id)
      }
      setSearchOverlay((prev) =>
        prev === null
          ? null
          : { ...prev, members: prev.members.filter((m) => m.id !== memberId) },
      )
    },
    [registry, serverId],
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
    setSearchOverlay({
      serverId: serverId!,
      query: q,
      members: [],
      status: "loading",
    })
    void runSearch(q, seq)
  }, [runSearch, serverId])

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
    members: isSearchingCurrentServer ? searchOverlay.members : paged.members,
    loading: paged.loading && enabled,
    loadingMore: paged.loadingMore,
    hasMore: paged.hasMore,
    total: paged.total,
    isSearching: isSearchingCurrentServer,
    searchQuery: isSearchingCurrentServer ? searchOverlay.query : "",
    searchStatus: isSearchingCurrentServer ? searchOverlay.status : "idle",
    failed: paged.failed,
    loadMore,
    reset,
    refresh,
    searchMembers,
    applyRoleChange,
    applyKick,
  }
}
