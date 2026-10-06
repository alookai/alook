"use client"

import { collectionEvidence, deriveView, valueEvidence, viewEvidence } from "@/lib/observability/data-source"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import type { QueryFunctionContext } from "@tanstack/react-query"

import { useQueryClient, useQuery, keepPreviousData, type UseQueryResult } from "@tanstack/react-query"
import { useMemo } from "react"
import { apiFetch } from "@/lib/api/client"
import {
  apiFetchProfiles,
  communityUserProfilePatch,
  loadAndSeedProfiles,
} from "@/lib/community/profile-seed"
import { communityKeys } from "@/lib/query-keys"
import type { Friend, PendingRequest, BlockedUser } from "@/lib/community/models/people"
import { useCanonicalProfilesByUserId, useFriendshipRows } from "@/lib/community-db/projections"
import { captureCommunityLiveSnapshotToken, assertCommunityLiveSnapshotTokenCurrent, publishCommunityFriendships } from "@/lib/community-db/sync"
import { readCommunityProfile } from "@/lib/community/profile-read"

/**
 * The community read routes wrap their D1 hits in `readOrStale` (see
 * `src/shared/src/db/resilience.ts`). On retry-exhaust they return
 * `200 { …, stale: true }` with empty payloads. Treat that as a query
 * error so `placeholderData: keepPreviousData` keeps the last-good data
 * on screen instead of flipping the UI to a false-empty state.
 */
class StaleReadError extends Error {
  constructor() { super("stale D1 read"); this.name = "StaleReadError" }
}
function throwIfStale<T extends { stale?: boolean }>(v: T): T {
  if (v?.stale) throw new StaleReadError()
  return v
}

/**
 * Fetches the friends / pending-requests / blocked triad in a single query.
 *
 * The context previously fired both endpoints in `Promise.all` from a single
 * `fetchFriends` — consumers always read the three together, so a single query
 * key (`communityKeys.friends()`) is the right cache grain: one invalidation
 * refreshes everything. If we split it, every friend-mutation would need to
 * fire two invalidations.
 */
export type FriendsResponse = {
  friends: Friend[]
  pending: PendingRequest[]
  blocked: BlockedUser[]
}

// Frozen empty fallbacks — see `use-servers.ts` for the rationale.
export const friendsQueryFn = async (context: QueryFunctionContext) => {
  const token = captureCommunityLiveSnapshotToken(context.client), registry = getCommunityDbRegistry(context.client)
  await registry?.ready
  assertCommunityLiveSnapshotTokenCurrent(context.client, token, context.signal)
  await registry!.collections.friendships.preload()
  assertCommunityLiveSnapshotTokenCurrent(context.client, token, context.signal)
  // The legacy aggregate GET /friends ({friends,blocked}) is retired — read each
  // bucket from its own sub-resource endpoint (friends/accepted · friends/blocked
  // · friends/pending) and compose the same triad. Same query key / cache grain
  // as before, so mutations still fire one invalidation.
  const [acceptedData, blockedData, pendingData] = await Promise.all([
    apiFetchProfiles<{ friends: Friend[]; stale?: boolean }>(
      "/api/community/friends/accepted",
      (data) => {
        throwIfStale(data)
        return data.friends.map((friend) => communityUserProfilePatch(friend.userId ?? friend.id, friend))
      }, { signal: context.signal }, getCommunityDbRegistry(context.client),
    ),
    apiFetchProfiles<{ blocked: BlockedUser[]; stale?: boolean }>(
      "/api/community/friends/blocked",
      (data) => {
        throwIfStale(data)
        return data.blocked.map((blocked) => ({
              id: blocked.userId ?? blocked.id,
              identityAbout: { name: blocked.name },
              avatar: {
                avatar: blocked.avatar,
                avatarVersion: blocked.avatarVersion,
              },
            }))
      }, { signal: context.signal }, getCommunityDbRegistry(context.client),
    ),
    apiFetchProfiles<{ pending: PendingRequest[]; stale?: boolean }>(
      "/api/community/friends/pending",
      (data) => {
        throwIfStale(data)
        return data.pending.map((pending) => ({
          id: pending.userId,
          identityAbout: { name: pending.name },
          avatar: {
            avatar: pending.avatar,
            avatarVersion: pending.avatarVersion,
          },
        }))
      }, { signal: context.signal }, getCommunityDbRegistry(context.client),
    ),
  ])
  publishCommunityFriendships(context.client, [
    ...acceptedData.friends.map((friend) => ({ id: friend.id, userId: friend.userId ?? friend.id, kind: "accepted" as const, sub: friend.sub })),
    ...pendingData.pending.map((pending) => ({ id: pending.id, userId: pending.userId, kind: pending.kind, needsOwnerApproval: pending.needsOwnerApproval })),
    ...blockedData.blocked.map((blocked) => ({ id: `blocked:${blocked.userId ?? blocked.id}`, userId: blocked.userId ?? blocked.id, kind: "blocked" as const })),
  ], { token, signal: context.signal })
  return { ids: [...acceptedData.friends.map((friend) => friend.id), ...pendingData.pending.map((pending) => pending.id), ...blockedData.blocked.map((blocked) => `blocked:${blocked.userId ?? blocked.id}`)] }
}

export function useFriends(): UseQueryResult<{ ids: string[] }> & {
  friends: Friend[]
  pending: PendingRequest[]
  blocked: BlockedUser[]
} {
  const client = useQueryClient()
  const registry = getCommunityDbRegistry(client)
  const query = useQuery({
    queryKey: communityKeys.friends(),
    queryFn: friendsQueryFn,
    placeholderData: keepPreviousData,
  })
  const profilesByUserId = useCanonicalProfilesByUserId()
  const rows = useFriendshipRows()
  const { friends, pending, blocked } = useMemo(() => {
    const friends: Friend[] = [], pending: PendingRequest[] = [], blocked: BlockedUser[] = []
    const rank = new Map(query.data?.ids.map((id, index) => [id, index]))
    for (const row of [...rows].sort((left, right) => (rank.get(left.id) ?? Infinity) - (rank.get(right.id) ?? Infinity))) {
      const profile = readCommunityProfile(profilesByUserId.get(row.userId), row.userId)
      if (row.kind === "accepted") friends.push({ id: row.id, userId: row.userId, name: profile.name, discriminator: profile.discriminator, avatar: profile.avatar, avatarVersion: profile.avatarVersion, status: profile.presence, statusEmoji: profile.statusEmoji, statusText: profile.statusText, sub: row.sub ?? "" })
      else if (row.kind === "blocked") blocked.push({ id: row.id, userId: row.userId, name: profile.name, avatar: profile.avatar, avatarVersion: profile.avatarVersion })
      else pending.push({ id: row.id, userId: row.userId, kind: row.kind, name: profile.name, avatar: profile.avatar, avatarVersion: profile.avatarVersion, needsOwnerApproval: row.needsOwnerApproval })
    }
    return { friends, pending, blocked }
  }, [rows, profilesByUserId, query.data?.ids])
  const evidence = [valueEvidence(client, query.data), ...(registry ? [collectionEvidence(client, "friendships", rows.map(row => row.id), rows)] : []), ...rows.map(row => viewEvidence(profilesByUserId.get(row.userId)))]
  deriveView(friends, evidence)
  deriveView(pending, evidence)
  deriveView(blocked, evidence)
  return { ...query, friends, pending, blocked }
}

/**
 * Fetches the bulk online/offline check for the caller's own friends — the
 * friends-list analogue of `usePresence(serverId)` in `use-server-panels.ts`.
 *
 * Friends can be online without ever sharing a server, so the co-member-
 * scoped WS presence snapshot alone never learns about them. This seeds the
 * global profile map on mount; WS `community:presence.update` events keep it
 * fresh afterward.
 */
export type FriendsPresenceResponse = { online: string[] }

export const friendsPresenceQueryFn = (context: QueryFunctionContext) =>
  loadAndSeedProfiles(
    (origin) => apiFetch<FriendsPresenceResponse & { stale?: boolean }>(
      "/api/community/friends/presence",
      origin,
    ).then(throwIfStale),
    (data) => data.online.map((id) => ({ id, presence: "online" })),
    getCommunityDbRegistry(context.client),
    context.signal,
  )

const EMPTY_ONLINE: readonly string[] = Object.freeze([])

export function useFriendsPresence(enabled = true): UseQueryResult<FriendsPresenceResponse> & {
  online: readonly string[]
} {
  const query = useQuery({
    queryKey: communityKeys.friendsPresence(),
    queryFn: friendsPresenceQueryFn,
    placeholderData: keepPreviousData,
    enabled,
    subscribed: enabled,
  })
  return {
    ...query,
    online: query.data?.online ?? EMPTY_ONLINE,
  }
}
