"use client"

import { useEffect, useMemo } from "react"
import { createStore, useSelector } from "@tanstack/react-store"
import { useInfiniteQuery, useMutationState, useQueryClient, replaceEqualDeep, type InfiniteData, type Query, type QueryKey, type QueryClient } from "@tanstack/react-query"
import { apiFetch, toastApiError } from "@/lib/api/client"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { captureCommunityLiveSnapshotToken, assertCommunityLiveSnapshotTokenCurrent, publishCommunityMembersSnapshot } from "@/lib/community-db/sync"
import { communityRequestOptions } from "@/lib/community/account-cache-lifecycle"
import { beginCommunityProfileSeed, writeCommunityProfilePatches, communityUserProfilePatch } from "@/lib/community/profile-seed"
import { getMemberReadState, useCanonicalProfilesProjection, useServerMemberProjection } from "@/lib/community-db/projections"
import { readCommunityProfile } from "@/lib/community/profile-read"
import { serverMembershipKey } from "@/lib/community-db/schema"
import { useCommunityViewSource } from "./use-community-view-source"
import { communityKeys } from "@/lib/query-keys"
import type { Member } from "@/lib/community/models/people"
import type { CommunityMemberJoin, CommunityMemberLeave, CommunityMemberUpdate, CommunityRole } from "@alook/shared"
import { avatarInitial } from "@/lib/community/avatar"

// Debounce window for the search input (ms). Kept short — the endpoint is
// prefix-only and cheap, but avoid a fetch per keystroke.
export const SEARCH_DEBOUNCE_MS = 200

// ── Pure reducers (exported for direct unit tests) ────────────────────────────
//
// WS-event insertion rules for paginated member lists:
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
      avatarVersion: event.member.avatarVersion,
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
  hasMore: boolean
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

export type MemberIdentity = Pick<Member, "id" | "userId">
export type MemberWindow = {
  members: MemberIdentity[]
  hasMore: boolean
  cursor?: string
  limit: number
  total?: number
  liveRevision: number
}
export type MembersWindowCache = InfiniteData<MemberWindow, string | null | undefined>
type MemberReadProtocol = {
  operation: Promise<unknown> | undefined
  token: ReturnType<typeof captureCommunityLiveSnapshotToken>
  profileSnapshot: ReturnType<typeof beginCommunityProfileSeed>
  baselineIds: ReadonlySet<string>
  liveRevision: number
}
const memberReads = new WeakMap<Query, ReturnType<typeof createStore<MemberReadProtocol>>>()

function beginMemberRead(client: QueryClient, key: QueryKey) {
  const resource = client.getQueryCache().find({ queryKey: key, exact: true })
  const existing = resource ? memberReads.get(resource) : undefined
  if (existing && existing.get().operation === resource!.promise) return { resource, protocol: existing.get() }
  const cached = resource?.state.data as MembersWindowCache | undefined
  const protocol: MemberReadProtocol = {
    operation: resource?.promise,
    token: captureCommunityLiveSnapshotToken(client),
    profileSnapshot: beginCommunityProfileSeed(getCommunityDbRegistry(client)),
    baselineIds: new Set(cached?.pages.flatMap((page) => page.members.map((member) => member.id)) ?? []),
    liveRevision: Math.max(0, ...(cached?.pages.map((page) => page.liveRevision ?? 0) ?? [])),
  }
  if (resource) {
    const state = existing ?? createStore(protocol)
    state.setState(() => protocol)
    memberReads.set(resource, state)
  }
  return { resource, protocol }
}

export const membersPageQueryFn = (serverId: string, search = "", limit?: number) =>
  async ({ pageParam, client, signal, queryKey }: { pageParam: string | null | undefined; client: QueryClient; signal?: AbortSignal; queryKey?: QueryKey }): Promise<MemberWindow> => {
    const key = queryKey ?? communityKeys.members(serverId)
    const { resource, protocol } = beginMemberRead(client, key)
    const { token, profileSnapshot } = protocol
    const registry = token.registry!
    const assert = () => {
      assertCommunityLiveSnapshotTokenCurrent(client, token, signal)
      if (resource && client.getQueryCache().find({ queryKey: key, exact: true }) !== resource) throw new DOMException("Retired member resource", "AbortError")
    }
    assert()
    await registry.ready
    await registry.collections.serverMemberships.preload()
    assert()
    const params = new URLSearchParams()
    if (pageParam) params.set("cursor", pageParam)
    if (search) params.set("q", search)
    if (limit) params.set("limit", String(limit))
    const path = "/api/community/servers/" + serverId + "/members" + (search ? "/search" : "") + (params.size ? "?" + params : "")
    const data = await apiFetch<MembersEnvelope | SearchEnvelope>(path, communityRequestOptions(client, token, signal, assert))
    assert()
    if (data.hasMore && !data.cursor) throw new Error("members page missing cursor")
    writeCommunityProfilePatches(data.members.map((member) => communityUserProfilePatch(member.userId, member)), registry, { snapshot: profileSnapshot })
    publishCommunityMembersSnapshot(client, serverId, data.members, { token, signal })
    assert()
    return { members: data.members.map(({ id, userId }) => ({ id, userId })), hasMore: data.hasMore, cursor: data.cursor, limit: data.limit, ...("total" in data ? { total: data.total } : {}), liveRevision: protocol.liveRevision }
  }

export function mergeMemberWindows(client: QueryClient, key: QueryKey, previous: unknown, next: unknown): MembersWindowCache {
  const incoming = next as MembersWindowCache
  const old = previous as MembersWindowCache | undefined
  const resource = client.getQueryCache().find({ queryKey: key, exact: true })
  const read = resource ? memberReads.get(resource)?.get() : undefined
  if (!read || !old?.pages.length) return replaceEqualDeep(previous, incoming)
  const oldRevision = Math.max(0, ...old.pages.map((page) => page.liveRevision ?? 0))
  if (Math.max(0, ...incoming.pages.map((page) => page.liveRevision ?? 0)) > oldRevision) return replaceEqualDeep(previous, incoming)
  if (oldRevision <= read.liveRevision) return replaceEqualDeep(previous, incoming)
  const serverId = key[2] as string
  const registry = read.token.registry
  const pages = incoming.pages.map((page) => ({ ...page, liveRevision: oldRevision, members: page.members.filter((member) => registry?.collections.serverMemberships.get(serverMembershipKey(serverId, member.userId))?.memberId === member.id), ...(page.total === undefined ? {} : { total: old.pages[0]?.total ?? page.total }) }))
  const tail = pages.at(-1)
  if (tail && !tail.hasMore && key[4] !== "search") {
    const seen = new Set(pages.flatMap((page) => page.members.map((member) => member.id)))
    for (const member of old.pages.flatMap((page) => page.members)) {
      if (read.baselineIds.has(member.id) || seen.has(member.id) || registry?.collections.serverMemberships.get(serverMembershipKey(serverId, member.userId))?.memberId !== member.id) continue
      tail.members.push(member)
      seen.add(member.id)
    }
  }
  return replaceEqualDeep(previous, { ...incoming, pages })
}

export function patchMemberKickWindows(client: QueryClient, resources: readonly Query[], memberId: string) {
  for (const query of resources) {
    if (client.getQueryCache().find({ queryKey: query.queryKey, exact: true }) !== query) continue
    const current = query.state.data as MembersWindowCache | undefined
    if (!current?.pages?.length) continue
    const revision = Math.max(0, ...current.pages.map((page) => page.liveRevision ?? 0)) + 1
    const pages = current.pages.map((page) => ({ ...page, liveRevision: revision, members: page.members.filter((member) => member.id !== memberId), ...(page.total === undefined ? {} : { total: Math.max(0, page.total - 1) }) }))
    client.setQueryData(query.queryKey, { ...current, pages })
  }
}

export function patchMemberWindows(client: QueryClient, event: CommunityMemberJoin | CommunityMemberLeave | CommunityMemberUpdate) {
  const root = communityKeys.members(event.serverId)
  for (const query of client.getQueryCache().findAll({ queryKey: root })) {
    const current = query.state.data as MembersWindowCache | undefined
    if (!current?.pages?.length) {
      if (query.state.fetchStatus !== "fetching") continue
      const original = captureCommunityLiveSnapshotToken(client)
      void client.cancelQueries({ queryKey: query.queryKey, exact: true }).then(() => {
        assertCommunityLiveSnapshotTokenCurrent(client, original, undefined)
        if (client.getQueryCache().find({ queryKey: query.queryKey, exact: true }) === query) return client.invalidateQueries({ queryKey: query.queryKey, exact: true }, { cancelRefetch: false })
      }).catch(() => undefined)
      continue
    }
    if (query.queryKey[4] === "search") {
      if (event.type === "community:member.update" && event.changes.nickname === undefined) continue
      if (event.type !== "community:member.leave") { void client.invalidateQueries({ queryKey: query.queryKey, exact: true }, { cancelRefetch: false }); continue }
    }
    const revision = Math.max(0, ...current.pages.map((page) => page.liveRevision ?? 0)) + 1
    let delta = 0
    let pages = current.pages.map((page) => ({ ...page, liveRevision: revision }))
    if (event.type === "community:member.join") {
      if (pages.some((page) => page.members.some((member) => member.userId === event.member.userId))) {
        if (pages.some((page) => page.members.some((member) => member.id === event.member.id))) continue
        pages = pages.map((page) => ({ ...page, members: page.members.map((member) => member.userId === event.member.userId ? { id: event.member.id, userId: event.member.userId } : member) }))
        client.setQueryData(query.queryKey, { ...current, pages })
        continue
      }
      delta = 1
      const tail = pages.at(-1)!
      if (!tail.hasMore) tail.members = [...tail.members, { id: event.member.id, userId: event.member.userId }]
    } else if (event.type === "community:member.leave") {
      delta = -1
      pages = pages.map((page) => ({ ...page, members: page.members.filter((member) => member.userId !== event.userId) }))
    }
    pages = pages.map((page) => ({ ...page, ...(page.total === undefined ? {} : { total: Math.max(0, page.total + delta) }) }))
    client.setQueryData(query.queryKey, { ...current, pages })
  }
}

type MemberSearchStatus = "idle" | "loading" | "loading-more" | "ready" | "empty" | "error"
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
}

export function useServerMembers(serverId: string | null): UseServerMembers {
  const queryClient = useQueryClient()
  const source = useCommunityViewSource("server-members:" + serverId, !!serverId)
  const intent = useMemo(() => createStore({ queryClient, serverId, query: "", debounced: "" }), [queryClient, serverId])
  const searchIntent = useSelector(intent, (state) => state)
  useEffect(() => {
    if (!serverId || searchIntent.query === searchIntent.debounced) return
    const assert = source.capture()
    const timer = setTimeout(() => {
      try { assert() } catch { return }
      intent.setState((state) => state.query === searchIntent.query ? { ...state, debounced: state.query } : state)
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [intent, searchIntent.query, searchIntent.debounced, serverId, source.signal, source])
  const key = communityKeys.members(serverId ?? "__none__")
  const searching = !!serverId && !!searchIntent.query
  const infinite = useInfiniteQuery({
    queryKey: key, queryFn: membersPageQueryFn(serverId ?? "__none__"),
    initialPageParam: null as string | null | undefined,
    getNextPageParam: (last) => last.hasMore ? last.cursor : undefined,
    enabled: !!serverId, subscribed: !!serverId,
    staleTime: Infinity, refetchOnReconnect: true,
    structuralSharing: (previous, next) => mergeMemberWindows(queryClient, key, previous, next),
  })
  const searchKey = [...key, "search", searchIntent.debounced] as const
  const searchReady = searching && searchIntent.query === searchIntent.debounced
  const search = useInfiniteQuery({
    queryKey: searchKey, queryFn: membersPageQueryFn(serverId ?? "__none__", searchIntent.debounced),
    initialPageParam: null as string | null | undefined,
    getNextPageParam: (last) => last.hasMore ? last.cursor : undefined,
    enabled: searchReady, subscribed: searchReady,
    retry: false, staleTime: Infinity, refetchOnReconnect: true,
    structuralSharing: (previous, next) => mergeMemberWindows(queryClient, searchKey, previous, next),
  })
  useEffect(() => {
    if (!searchReady || !search.error || search.isFetching) return
    let assertActive: ReturnType<typeof source.capture>
    try { assertActive = source.capture(); assertActive() } catch { return }
    toastApiError(search.error, "Search failed", assertActive)
  }, [searchReady, search.error, search.isFetching, source])
  const fetchNextSearchPage = search.fetchNextPage
  useEffect(() => {
    if (searchReady && search.hasNextPage && !search.isFetching && !search.isError) void fetchNextSearchPage({ cancelRefetch: false })
  }, [searchReady, search.hasNextPage, search.isFetching, search.isError, search.data, fetchNextSearchPage])
  const data = searching ? searchReady ? search.data : undefined : infinite.data
  const identities = useMemo(() => {
    const seen = new Set<string>()
    return data?.pages.flatMap((page) => page.members).filter((member) => {
      if (seen.has(member.id)) return false
      seen.add(member.id)
      return true
    }) ?? []
  }, [data])
  const membershipProjection = useServerMemberProjection(serverId, identities.map((member) => member.userId))
  const profileProjection = useCanonicalProfilesProjection(identities.map((member) => member.userId))
  const profiles = profileProjection.data
  const members = useMemo(() => {
    const byUser = new Map((membershipProjection.data ?? []).map((row) => [row.userId, row]))
    return identities.flatMap((identity) => {
      const row = byUser.get(identity.userId)
      if (!row || row.memberId !== identity.id) return []
      const profile = readCommunityProfile(profiles.get(identity.userId), identity.userId)
      return [{ id: identity.id, userId: identity.userId, name: row.nickname ?? profile.name, discriminator: profile.discriminator, avatar: profile.avatar, avatarVersion: profile.avatarVersion, role: row.role as CommunityRole, status: row.viewer ? "online" as const : profile.presence, sub: "", statusEmoji: profile.statusEmoji, statusText: profile.statusText }]
    })
  }, [identities, membershipProjection.data, profiles])
  const active = searching ? search : infinite
  const readState = getMemberReadState(!!serverId, { pending: !data || active.isRefetching, failed: (!searching || searchReady) && active.isError && !active.isFetching }, [membershipProjection, profileProjection], members.filter((member) => member.userId !== membershipProjection.registry?.accountId).map((member) => member.userId), profiles)
  const pendingKicks = useMutationState({ filters: { mutationKey: ["community", "member-command"], status: "pending" }, select: (mutation) => {
    const variables = mutation.state.variables as { kind: string; input: { serverId: string; memberId: string } }
    const current = queryClient.getQueryData<MembersWindowCache>(key)
    return variables.kind === "kick" && variables.input.serverId === serverId && current?.pages.some((page) => page.members.some((member) => member.id === variables.input.memberId)) ? 1 : 0
  } })
  const assertView = () => source.capture()()
  return {
    members: serverId ? members : [], loading: readState.loading,
    loadingMore: active.isFetchingNextPage, hasMore: active.hasNextPage,
    total: Math.max(0, (infinite.data?.pages.at(-1)?.total ?? 0) - pendingKicks.reduce<number>((sum, value) => sum + value, 0)), isSearching: searching,
    searchQuery: searching ? searchIntent.query : "",
    searchStatus: !searching ? "idle" : readState.failed ? "error" : readState.loading ? "loading" : search.isFetchingNextPage || search.hasNextPage ? "loading-more" : members.length ? "ready" : "empty",
    failed: readState.failed,
    loadMore: () => { assertView(); if (active.hasNextPage && !active.isFetchingNextPage) void active.fetchNextPage({ cancelRefetch: false }) },
    reset: () => { assertView(); intent.setState((state) => ({ ...state, query: "", debounced: "" })) },
    refresh: () => { assertView(); void queryClient.invalidateQueries({ queryKey: key }, { cancelRefetch: false }) },
    searchMembers: (query) => { assertView(); intent.setState((state) => { const trimmed = query.trim(); return state.query === trimmed ? state : { ...state, query: trimmed, debounced: trimmed ? state.debounced : "" } }) },
  }
}
