"use client"

import { useQuery, keepPreviousData, type UseQueryResult } from "@tanstack/react-query"
import { useMemo } from "react"
import { apiFetch } from "@/lib/api/client"
import {
  apiFetchProfiles,
  communityUserProfilePatch,
  loadAndSeedProfiles,
} from "@/lib/community/profile-seed"
import { communityKeys } from "@/lib/query-keys"
import type { Friend, PendingRequest, BlockedUser } from "@/lib/community/models/people"
import { useProfilesByUserId } from "@/stores/community/ws"
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
const EMPTY_FRIENDS: readonly Friend[] = Object.freeze([])
const EMPTY_PENDING: readonly PendingRequest[] = Object.freeze([])
const EMPTY_BLOCKED: readonly BlockedUser[] = Object.freeze([])

export const friendsQueryFn = async (): Promise<FriendsResponse> => {
  // The legacy aggregate GET /friends ({friends,blocked}) is retired — read each
  // bucket from its own sub-resource endpoint (friends/accepted · friends/blocked
  // · friends/pending) and compose the same triad. Same query key / cache grain
  // as before, so mutations still fire one invalidation.
  const [acceptedData, blockedData, pendingData] = await Promise.all([
    apiFetchProfiles<{ friends: Friend[]; stale?: boolean }>(
      "/api/community/friends/accepted",
      (data) => {
        throwIfStale(data)
        return data.friends.flatMap((friend) =>
          friend.userId ? [communityUserProfilePatch(friend.userId, friend)] : [])
      },
    ),
    apiFetchProfiles<{ blocked: BlockedUser[]; stale?: boolean }>(
      "/api/community/friends/blocked",
      (data) => {
        throwIfStale(data)
        return data.blocked.flatMap((blocked) => blocked.userId
          ? [{
              id: blocked.userId,
              identityAbout: { name: blocked.name },
              avatar: {
                avatar: blocked.avatar,
                avatarVersion: blocked.avatarVersion,
              },
            }]
          : [])
      },
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
      },
    ),
  ])
  return {
    friends: acceptedData.friends,
    blocked: blockedData.blocked,
    pending: pendingData.pending,
  }
}

export function useFriends(): UseQueryResult<FriendsResponse> & {
  friends: Friend[]
  pending: PendingRequest[]
  blocked: BlockedUser[]
} {
  const query = useQuery({
    queryKey: communityKeys.friends(),
    queryFn: friendsQueryFn,
    placeholderData: keepPreviousData,
  })
  const profilesByUserId = useProfilesByUserId()
  const friends = useMemo(
    () => (query.data?.friends ?? EMPTY_FRIENDS).map((friend) => {
      if (!friend.userId) return friend
      const profile = readCommunityProfile(
        profilesByUserId.get(friend.userId),
        friend.userId,
      )
      return {
        ...friend,
        name: profile.name,
        discriminator: profile.discriminator,
        avatar: profile.avatar,
        avatarVersion: profile.avatarVersion,
        status: profile.presence,
        statusEmoji: profile.statusEmoji,
        statusText: profile.statusText,
      }
    }),
    [profilesByUserId, query.data?.friends],
  )
  const pending = useMemo(
    () => (query.data?.pending ?? EMPTY_PENDING).map((request) => {
      const profile = readCommunityProfile(
        profilesByUserId.get(request.userId),
        request.userId,
      )
      return {
        ...request,
        name: profile.name,
        avatar: profile.avatar,
        avatarVersion: profile.avatarVersion,
      }
    }),
    [profilesByUserId, query.data?.pending],
  )
  const blocked = useMemo(
    () => (query.data?.blocked ?? EMPTY_BLOCKED).map((entry) => {
      if (!entry.userId) return entry
      const profile = readCommunityProfile(
        profilesByUserId.get(entry.userId),
        entry.userId,
      )
      return {
        ...entry,
        name: profile.name,
        avatar: profile.avatar,
        avatarVersion: profile.avatarVersion,
      }
    }),
    [profilesByUserId, query.data?.blocked],
  )
  return {
    ...query,
    friends,
    pending,
    blocked,
  }
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

export const friendsPresenceQueryFn = () =>
  loadAndSeedProfiles(
    () => apiFetch<FriendsPresenceResponse & { stale?: boolean }>(
      "/api/community/friends/presence",
    ).then(throwIfStale),
    (data) => data.online.map((id) => ({ id, presence: "online" })),
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
  })
  return {
    ...query,
    online: query.data?.online ?? EMPTY_ONLINE,
  }
}
