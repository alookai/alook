"use client"

import { useMemo } from "react"
import { QueryObserver,useQuery,type QueryFunctionContext,type UseQueryResult } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import type { Friend } from "@/lib/community/models/people"
import { fetchAllServerMembers } from "./fetch-all-server-members"
import { friendsQueryFn } from "./use-friends"
import { captureCommunityLiveSnapshotToken,assertCommunityLiveSnapshotTokenCurrent } from "@/lib/community-db/sync"
import { useCanonicalProfilesByUserId,useFriendshipRows,useServerMemberRows } from "@/lib/community-db/projections"
import { readCommunityProfile } from "@/lib/community/profile-read"

export type InvitableFriendsResponse = { friends: Friend[] }

async function invitableFriendsQueryFn(serverId: string, context: QueryFunctionContext) {
  const original = captureCommunityLiveSnapshotToken(context.client)
  const assert = () => assertCommunityLiveSnapshotTokenCurrent(context.client, original, context.signal)
  assert()
  const options = { queryKey: communityKeys.friends(), queryFn: friendsQueryFn }
  const observer = new QueryObserver(context.client, { ...options, enabled: false })
  const unsubscribe = observer.subscribe(() => undefined)
  context.signal.addEventListener("abort", unsubscribe, { once: true })
  try {
    const [accepted] = await Promise.all([context.client.fetchQuery(options), fetchAllServerMembers(context.client, serverId, context.signal)])
    assert()
    const allowed = new Set(accepted.ids)
    return { serverId, friendIds: [...original.registry!.collections.friendships.values()].filter((row) => row.kind === "accepted" && allowed.has(row.id)).map((row) => row.id) }
  } finally { context.signal.removeEventListener("abort", unsubscribe); unsubscribe() }
}

export function useInvitableFriends(serverId: string, enabled = true): UseQueryResult<InvitableFriendsResponse> & { friends: Friend[] } {
  const active = enabled && !!serverId
  const query = useQuery({ queryKey: communityKeys.invitableFriends(serverId), queryFn: (context) => invitableFriendsQueryFn(serverId, context), enabled: active, subscribed: active, retry: false })
  const rows = useFriendshipRows(query.data?.friendIds ?? [])
  const profiles = useCanonicalProfilesByUserId(rows.map((row) => row.userId))
  const members = useServerMemberRows(serverId, rows.map((row) => row.userId))
  const friends = useMemo<Friend[]>(() => {
    const present = new Set(members.map((row) => row.userId))
    return rows.flatMap((row) => {
      if (row.kind !== "accepted" || present.has(row.userId)) return []
      const profile = readCommunityProfile(profiles.get(row.userId), row.userId)
      return [{ id: row.id, userId: row.userId, name: profile.name, discriminator: profile.discriminator, avatar: profile.avatar, avatarVersion: profile.avatarVersion, status: profile.presence, sub: row.sub ?? "", statusEmoji: profile.statusEmoji, statusText: profile.statusText }]
    })
  }, [rows, profiles, members])
  const data = useMemo(() => query.data ? { friends } : undefined, [query.data, friends])
  return { ...query, data, friends } as UseQueryResult<InvitableFriendsResponse> & { friends: Friend[] }
}
