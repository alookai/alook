"use client"

import { useQuery, keepPreviousData, type UseQueryResult } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import type { Friend, PendingRequest, BlockedUser } from "@/components/community/_types"

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
  const [friendsData, pendingData] = await Promise.all([
    apiFetch<{ friends: Friend[]; blocked: BlockedUser[]; stale?: boolean }>("/api/community/friends").then(throwIfStale),
    apiFetch<{ pending: PendingRequest[]; stale?: boolean }>("/api/community/friends/pending").then(throwIfStale),
  ])
  return {
    friends: friendsData.friends,
    blocked: friendsData.blocked,
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
  return {
    ...query,
    friends: query.data?.friends ?? (EMPTY_FRIENDS as Friend[]),
    pending: query.data?.pending ?? (EMPTY_PENDING as PendingRequest[]),
    blocked: query.data?.blocked ?? (EMPTY_BLOCKED as BlockedUser[]),
  }
}

/**
 * Fetches the bulk online/offline check for the caller's own friends — the
 * friends-list analogue of `usePresence(serverId)` in `use-server-panels.ts`.
 *
 * Friends can be online without ever sharing a server, so the co-member-
 * scoped WS presence snapshot alone never learns about them. This seeds
 * `useCommunityWsStore`'s `onlineUserIds` on mount (see
 * `app/c/me/layout.tsx`); WS `community:presence.update` events
 * keep it fresh afterward.
 */
export type FriendsPresenceResponse = { online: string[] }

export const friendsPresenceQueryFn = () =>
  apiFetch<FriendsPresenceResponse & { stale?: boolean }>("/api/community/friends/presence").then(throwIfStale)

const EMPTY_ONLINE: readonly string[] = Object.freeze([])

export function useFriendsPresence(): UseQueryResult<FriendsPresenceResponse> & {
  online: readonly string[]
} {
  const query = useQuery({
    queryKey: communityKeys.friendsPresence(),
    queryFn: friendsPresenceQueryFn,
    placeholderData: keepPreviousData,
  })
  return {
    ...query,
    online: query.data?.online ?? EMPTY_ONLINE,
  }
}
