"use client"

import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import type { Friend, PendingRequest, BlockedUser } from "@/components/community/_types"

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
    apiFetch<{ friends: Friend[]; blocked: BlockedUser[] }>("/api/community/friends"),
    apiFetch<{ pending: PendingRequest[] }>("/api/community/friends/pending"),
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
  })
  return {
    ...query,
    friends: query.data?.friends ?? (EMPTY_FRIENDS as Friend[]),
    pending: query.data?.pending ?? (EMPTY_PENDING as PendingRequest[]),
    blocked: query.data?.blocked ?? (EMPTY_BLOCKED as BlockedUser[]),
  }
}
