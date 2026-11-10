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
import { parseCommunityServerMembersRead } from "@alook/shared"
import type { CommunityMemberJoin, CommunityMemberLeave, CommunityMemberUpdate, CommunityRole } from "@alook/shared"

export const SEARCH_DEBOUNCE_MS = 200

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
    const data = parseCommunityServerMembersRead(await apiFetch<unknown>(path, communityRequestOptions(client, token, signal, assert)), serverId, registry.accountId!, !!search)
    assert()
    if (data.hasMore && !data.cursor) throw new Error("members page missing cursor")
    await writeCommunityProfilePatches(data.members.map((member) => communityUserProfilePatch(member.userId, member)), registry, { snapshot: profileSnapshot })
    await publishCommunityMembersSnapshot(client, serverId, data.members, { token, signal })
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
    const assert = source.tryCapture()
    if (!assert) return
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
    const assertActive = source.tryCapture()
    if (!assertActive) return
    toastApiError(search.error, "Search failed", assertActive)
  }, [searchReady, search.error, search.isFetching, source])
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
      return [{ id: identity.id, userId: identity.userId, name: row.nickname ?? profile.name, discriminator: profile.discriminator, avatar: profile.avatar, avatarVersion: profile.avatarVersion, role: row.role as CommunityRole, status: profile.presence, sub: "", statusEmoji: profile.statusEmoji, statusText: profile.statusText }]
    })
  }, [identities, membershipProjection.data, profiles])
  const active = searching ? search : infinite
  const readState = getMemberReadState(!!serverId, { pending: !data || active.isRefetching, failed: (!searching || searchReady) && active.isError && !active.isFetching }, [membershipProjection, profileProjection], identities.filter((member) => member.userId !== membershipProjection.registry?.accountId).map((member) => member.userId), profileProjection.resourceProfiles)
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
    searchStatus: !searching ? "idle" : readState.failed ? "error" : readState.loading ? "loading" : search.isFetchingNextPage ? "loading-more" : members.length ? "ready" : "empty",
    failed: readState.failed,
    loadMore: () => { assertView(); if ((!searching || searchReady) && active.hasNextPage && !active.isFetching) void active.fetchNextPage({ cancelRefetch: false }) },
    reset: () => { assertView(); intent.setState((state) => ({ ...state, query: "", debounced: "" })) },
    refresh: () => { assertView(); void queryClient.invalidateQueries({ queryKey: key }, { cancelRefetch: false }) },
    searchMembers: (query) => {
      try { assertView() } catch { return }
      intent.setState((state) => { const trimmed = query.trim(); return state.query === trimmed ? state : { ...state, query: trimmed, debounced: trimmed ? state.debounced : "" } })
    },
  }
}
