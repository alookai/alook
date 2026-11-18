"use client"

import { useMemo } from "react"
import { QueryObserver,useQuery,useQueryClient,type QueryFunctionContext,type UseQueryResult } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import type { Friend } from "@/lib/community/models/people"
import { fetchAllServerMembers } from "./fetch-all-server-members"
import { friendsQueryFn } from "./use-friends"
import { captureCommunityLiveSnapshotToken,assertCommunityLiveSnapshotTokenCurrent } from "@/lib/community-db/sync"
import { useCanonicalProfilesProjection,useFriendshipProjection,useServerMemberProjection } from "@/lib/community-db/projections"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { readCommunityProfile } from "@/lib/community/profile-read"
import type { InvitableFriendsWindow } from "@/lib/community/directory-window-persistence"

type InvitableFriendsResponse = { friends: Friend[] }

async function invitableFriendsQueryFn(serverId: string, context: QueryFunctionContext): Promise<InvitableFriendsWindow> {
  const original = captureCommunityLiveSnapshotToken(context.client)
  const assert = () => assertCommunityLiveSnapshotTokenCurrent(context.client, original, context.signal)
  assert()
  const auxiliaryReadEpoch = await original.registry!.captureAuxiliaryReadEpoch()
  assert()
  const options = { queryKey: communityKeys.friends(), queryFn: friendsQueryFn, ...(auxiliaryReadEpoch ? { staleTime: 0 } : {}) }
  const observer = new QueryObserver(context.client, { ...options, enabled: false })
  const unsubscribe = observer.subscribe(() => undefined)
  context.signal.addEventListener("abort", unsubscribe, { once: true })
  try {
    const [accepted, members] = await Promise.all([context.client.query({ ...options, select: undefined }), fetchAllServerMembers(context.client, serverId, context.signal)])
    assert()
    const allowed = new Set(accepted.ids)
    const friends = [...original.registry!.collections.friendships.values()].filter((row) => row.kind === "accepted" && allowed.has(row.id))
    const present = new Set(members.map(member => member.userId))
    return { serverId, friendIds: friends.filter(row => !present.has(row.userId)).map(row => row.id), totalFriends: friends.length, observed: true, ...(auxiliaryReadEpoch ? { auxiliaryReadEpoch } : {}) }
  } finally { context.signal.removeEventListener("abort", unsubscribe); unsubscribe() }
}

type InvitableFriendsResult = Omit<UseQueryResult<InvitableFriendsWindow>, "data"> & { data: InvitableFriendsResponse | undefined; friends: Friend[]; totalFriends: number; observed: boolean; isCurrentRead: () => boolean }

export function useInvitableFriends(serverId: string, enabled = true): InvitableFriendsResult {
  const client = useQueryClient()
  const active = enabled && !!serverId
  const query = useQuery({ queryKey: communityKeys.invitableFriends(serverId), queryFn: (context) => invitableFriendsQueryFn(serverId, context), enabled: active, subscribed: active, retry: false })
  const friendshipProjection = useFriendshipProjection(query.data?.friendIds ?? [])
  const rows = useMemo(() => friendshipProjection.data ?? [], [friendshipProjection.data])
  const profileProjection = useCanonicalProfilesProjection(rows.map((row) => row.userId))
  const profiles = profileProjection.data
  const membershipProjection = useServerMemberProjection(serverId, rows.map((row) => row.userId))
  const members = useMemo(() => membershipProjection.data ?? [], [membershipProjection.data])
  const friends = useMemo<Friend[]>(() => {
    const present = new Set(members.map((row) => row.userId))
    return rows.flatMap((row) => {
      if (row.kind !== "accepted" || present.has(row.userId) || !profileProjection.resourceProfiles.has(row.userId)) return []
      const profile = readCommunityProfile(profiles.get(row.userId), row.userId)
      return [{ id: row.id, userId: row.userId, name: profile.name, discriminator: profile.discriminator, avatar: profile.avatar, avatarVersion: profile.avatarVersion, status: profile.presence, sub: row.sub ?? "", statusEmoji: profile.statusEmoji, statusText: profile.statusText }]
    })
  }, [rows, profiles, profileProjection.resourceProfiles, members])
  const complete = !!query.data && [friendshipProjection, profileProjection, membershipProjection].every(projection => projection.isReady && projection.isEnabled && !projection.isError)
    && query.data.friendIds.every(id => rows.some(row => row.id === id && row.kind === "accepted" && profileProjection.resourceProfiles.has(row.userId)))
  const data = useMemo(() => active && complete ? { friends } : undefined, [active, complete, friends])
  const totalFriends = query.data?.totalFriends ?? 0
  const isCurrentRead = () => {
    const state = client.getQueryState<InvitableFriendsWindow>(communityKeys.invitableFriends(serverId))
    return active && complete && getCommunityDbRegistry(client) === profileProjection.registry && state?.status === "success"
      && !state.isInvalidated && state.data === query.data && state.data?.observed === true
  }
  return { ...query, data, friends: active && complete ? friends : [], totalFriends, observed: isCurrentRead(), isCurrentRead }
}
