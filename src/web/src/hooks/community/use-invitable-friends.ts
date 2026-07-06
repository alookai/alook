"use client"

import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import type { Friend } from "@/components/community/_types"

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

export function useInvitableFriends(
  serverId: string,
  enabled = true,
): UseQueryResult<InvitableFriendsResponse> & { friends: Friend[] } {
  const query = useQuery({
    queryKey: communityKeys.invitableFriends(serverId),
    queryFn: () =>
      apiFetch<InvitableFriendsResponse>(
        `/api/community/servers/${encodeURIComponent(serverId)}/invitable-friends`,
      ),
    enabled: enabled && !!serverId,
  })
  return {
    ...query,
    friends: query.data?.friends ?? (EMPTY as Friend[]),
  }
}
