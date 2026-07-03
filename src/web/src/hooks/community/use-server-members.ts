"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { apiFetch } from "@/lib/api/client"
import type { Member } from "@/components/community/_types"
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

type MembersEnvelope = {
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
  handleMemberEvent: (event: CommunityMemberJoin | CommunityMemberLeave | CommunityMemberUpdate) => void
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
 * - "paged": append-only stream driven by `loadMore()` + cursor.
 * - "search": flat result set from /members/search, hides pagination.
 *
 * WS events (`handleMemberEvent`) only mutate the paged view — the server-side
 * cursor & fixtures never change under a live search, and switching modes is
 * cheap (empty `q` restores the paged pages/cursor as they were).
 */
export function useServerMembers(serverId: string | null): UseServerMembers {
  const [pages, setPages] = useState<Member[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [total, setTotal] = useState(0)
  const [searchResults, setSearchResults] = useState<Member[] | null>(null)

  // Refs so callbacks can read the latest state without re-binding — the
  // context wires `handleMemberEvent` into `useCommunityWs`, which memoises
  // its callbacks; stale closures over `pages` here would drop events.
  const cursorRef = useRef<string | null>(null)
  cursorRef.current = cursor
  const hasMoreRef = useRef(false)
  hasMoreRef.current = hasMore
  const loadingMoreRef = useRef(false)
  loadingMoreRef.current = loadingMore
  const serverIdRef = useRef<string | null>(serverId)
  serverIdRef.current = serverId

  // Debounce timer for search; the ref survives re-renders so a cancel from
  // the effect below actually clears the pending call.
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchSeq = useRef(0)

  const fetchPage = useCallback(async (opts: { cursor?: string | null }) => {
    const sid = serverIdRef.current
    if (!sid || sid === "@me") return
    const params = new URLSearchParams()
    if (opts.cursor) params.set("cursor", opts.cursor)
    const url = `/api/community/servers/${sid}/members${params.toString() ? `?${params}` : ""}`
    return apiFetch<MembersEnvelope>(url)
  }, [])

  const loadFirstPage = useCallback(async () => {
    const sid = serverIdRef.current
    if (!sid || sid === "@me") {
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const data = await fetchPage({ cursor: null })
      if (!data) return
      // Guard against a serverId flip that happened while this request was
      // in flight — otherwise we'd paint the wrong server's members.
      if (serverIdRef.current !== sid) return
      setPages(data.members)
      setCursor(data.cursor ?? null)
      setHasMore(data.hasMore)
      setTotal(data.total)
    } catch {
      if (serverIdRef.current === sid) {
        setPages([])
        setCursor(null)
        setHasMore(false)
        setTotal(0)
      }
    } finally {
      if (serverIdRef.current === sid) setLoading(false)
    }
  }, [fetchPage])

  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current) return
    if (!hasMoreRef.current) return
    if (!cursorRef.current) return
    const sid = serverIdRef.current
    if (!sid || sid === "@me") return
    setLoadingMore(true)
    try {
      const data = await fetchPage({ cursor: cursorRef.current })
      if (!data) return
      if (serverIdRef.current !== sid) return
      setPages((prev) => [...prev, ...data.members])
      setCursor(data.cursor ?? null)
      setHasMore(data.hasMore)
      setTotal(data.total)
    } catch {
      // Leave state — the sentinel effect will re-trigger loadMore on the
      // next scroll if the retry succeeds. Silent failure is intentional
      // (matches messages pagination behaviour).
    } finally {
      if (serverIdRef.current === sid) setLoadingMore(false)
    }
  }, [fetchPage])

  const reset = useCallback(() => {
    setPages([])
    setCursor(null)
    setHasMore(false)
    setTotal(0)
    setSearchResults(null)
    // Cancel any in-flight debounced search so it doesn't paint stale results.
    if (searchTimer.current) {
      clearTimeout(searchTimer.current)
      searchTimer.current = null
    }
    searchSeq.current += 1
  }, [])

  // Fetch page 1 whenever the serverId changes. `reset()` runs first via the
  // context (before serverId flips), and we then hydrate.
  useEffect(() => {
    if (!serverId || serverId === "@me") {
      setPages([])
      setCursor(null)
      setHasMore(false)
      setTotal(0)
      setSearchResults(null)
      setLoading(false)
      return
    }
    // Reset in-hook first, then load. `reset()` also cancels any debounced
    // search from the previous server.
    setPages([])
    setCursor(null)
    setHasMore(false)
    setTotal(0)
    setSearchResults(null)
    if (searchTimer.current) {
      clearTimeout(searchTimer.current)
      searchTimer.current = null
    }
    searchSeq.current += 1
    loadFirstPage()
  }, [serverId, loadFirstPage])

  const handleMemberEvent = useCallback(
    (event: CommunityMemberJoin | CommunityMemberLeave | CommunityMemberUpdate) => {
      // Event's `serverId` is filtered by the context caller (matches active
      // server). Left permissive here to keep the hook standalone.
      if (event.type === "community:member.join") {
        // Members are ordered by joinedAt ASC — a new joiner's joinedAt is
        // server-assigned and larger than every existing row, so it sorts to
        // the *tail*. Only append when we already hold the last page
        // (`!hasMore`); otherwise the joiner would appear as a duplicate once
        // the intervening pages load. The user will see them on scroll.
        if (hasMoreRef.current) return
        let appended = false
        setPages((prev) => {
          const next = applyJoinEvent(prev, event, false)
          if (next !== prev) appended = true
          return next
        })
        if (appended) setTotal((t) => t + 1)
        return
      }
      if (event.type === "community:member.leave") {
        let removed = false
        setPages((prev) => {
          const next = applyLeaveEvent(prev, event)
          if (next.length !== prev.length) removed = true
          return next
        })
        if (removed) setTotal((t) => Math.max(0, t - 1))
        return
      }
      // member.update: patch role/nickname in place.
      setPages((prev) => applyUpdateEvent(prev, event))
    },
    [],
  )

  const runSearch = useCallback(async (q: string, seq: number) => {
    const sid = serverIdRef.current
    if (!sid || sid === "@me") return
    try {
      const params = new URLSearchParams({ q })
      const data = await apiFetch<SearchEnvelope>(`/api/community/servers/${sid}/members/search?${params}`)
      // Guard against out-of-order responses.
      if (searchSeq.current !== seq) return
      if (serverIdRef.current !== sid) return
      setSearchResults(data.members)
    } catch {
      if (searchSeq.current === seq && serverIdRef.current === sid) {
        setSearchResults([])
      }
    }
  }, [])

  const searchMembers = useCallback((q: string) => {
    const trimmed = q.trim()
    if (searchTimer.current) {
      clearTimeout(searchTimer.current)
      searchTimer.current = null
    }
    searchSeq.current += 1
    if (trimmed.length === 0) {
      // Empty query — drop back to paged view. Pages/cursor are untouched.
      setSearchResults(null)
      return
    }
    const seq = searchSeq.current
    searchTimer.current = setTimeout(() => {
      searchTimer.current = null
      void runSearch(trimmed, seq)
    }, SEARCH_DEBOUNCE_MS)
  }, [runSearch])

  const applyRoleChange = useCallback((memberId: string, role: CommunityRole) => {
    setPages((prev) => prev.map((m) => (m.id === memberId ? { ...m, role } : m)))
    setSearchResults((prev) =>
      prev === null ? null : prev.map((m) => (m.id === memberId ? { ...m, role } : m)),
    )
  }, [])

  const applyKick = useCallback((memberId: string) => {
    let removed = false
    setPages((prev) => {
      const next = prev.filter((m) => m.id !== memberId)
      if (next.length !== prev.length) removed = true
      return next
    })
    setSearchResults((prev) =>
      prev === null ? null : prev.filter((m) => m.id !== memberId),
    )
    if (removed) setTotal((t) => Math.max(0, t - 1))
  }, [])

  // Cleanup any pending debounce on unmount so a late fire doesn't call
  // setState on a torn-down component.
  useEffect(() => {
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current)
    }
  }, [])

  return {
    members: searchResults ?? pages,
    loading,
    loadingMore,
    hasMore,
    total,
    isSearching: searchResults !== null,
    loadMore,
    reset,
    refresh: loadFirstPage,
    handleMemberEvent,
    searchMembers,
    applyRoleChange,
    applyKick,
  }
}
