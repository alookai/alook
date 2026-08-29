"use client"

import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import { apiFetchIdentity } from "@/lib/community/identity-projection"
import { communityKeys } from "@/lib/query-keys"
import type { Friend } from "@/lib/community/models/people"
import { fetchAllServerMembers } from "./fetch-all-server-members"

/**
 * Friends of the viewer who are NOT already members of `serverId` — feeds
 * the invite dialog's picker so already-joined friends never show up.
 *
 * Server-side filter, not a client-side subtract: a stale friends cache + a
 * stale members cache would race, and the caller doesn't necessarily hold
 * a members-list query for the target server (the dialog opens from the
 * sidebar header before any members query mounts).
 */
export type InvitableFriendsResponse = {
  friends: Friend[]
}

const EMPTY: readonly Friend[] = Object.freeze([])

export async function invitableFriendsQueryFn(serverId: string): Promise<InvitableFriendsResponse> {
  const [accepted, members] = await Promise.all([
    apiFetchIdentity<{ friends: Friend[]; stale?: boolean }>("/api/community/friends/accepted"),
    fetchAllServerMembers(serverId),
  ])
  if (accepted.stale) throw new Error("stale D1 read")
  const memberIds = new Set(members.map((member) => member.userId))
  return { friends: accepted.friends.filter((friend) => !friend.userId || !memberIds.has(friend.userId)) }
}

export function useInvitableFriends(
  serverId: string,
  enabled = true,
): UseQueryResult<InvitableFriendsResponse> & { friends: Friend[] } {
  const query = useQuery({
    queryKey: communityKeys.invitableFriends(serverId),
    queryFn: () => invitableFriendsQueryFn(serverId),
    enabled: enabled && !!serverId,
  })
  return {
    ...query,
    friends: query.data?.friends ?? (EMPTY as Friend[]),
  }
}
