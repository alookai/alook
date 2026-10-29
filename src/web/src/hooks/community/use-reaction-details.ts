"use client"
import { parseCommunityReactionDetailsRead, type CommunityReactionDetailsRead, type CommunityReactionActorProfile } from "@alook/shared"
import { createStore } from "@tanstack/react-store"
import { useCanonicalProfilesByUserId } from "@/lib/community-db/projections"
import { useCommunityViewSource } from "./use-community-view-source"
import { assertCommunityLiveSnapshotTokenCurrent, captureCommunityLiveSnapshotToken } from "@/lib/community-db/sync"
import { communityRequestOptions } from "@/lib/community/account-cache-lifecycle"



import { useEffect, useMemo } from "react"
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query"
import { apiFetchProfiles, communityUserProfilePatch } from "@/lib/community/profile-seed"
import { communityKeys } from "@/lib/query-keys"

export type ReactionDetailsProfile = CommunityReactionActorProfile
export type ReactionDetailsEnvelope = CommunityReactionDetailsRead

const loadReactionDetails = async (queryClient: QueryClient, messageId: string, signal: AbortSignal) => {
  const original = captureCommunityLiveSnapshotToken(queryClient)
  const registry = original.registry
  if (!registry) throw new DOMException("Missing reaction owner", "AbortError")
  await registry.ready
  await Promise.all([registry.collections.messages.preload(), registry.collections.channels.preload()])
  assertCommunityLiveSnapshotTokenCurrent(queryClient, original, signal)
  const message = registry.collections.messages.get(messageId)
  const channel = message ? registry.collections.channels.get(message.channelId) : undefined
  if (!message || !channel || channel.type !== "dm" && !channel.serverId) throw new Error("Missing reaction request scope")
  const scope: CommunityReactionDetailsRead["scope"] = channel.type === "dm" ? { kind: "dm", channelId: channel.id } : { kind: "server", channelId: channel.id, serverId: channel.serverId! }
  const data = await apiFetchProfiles<ReactionDetailsEnvelope>(
    `/api/community/messages/${messageId}/reactions`,
    (data) => parseCommunityReactionDetailsRead(data, messageId, scope).actors.flatMap((actor) => actor.profile ? [communityUserProfilePatch(actor.userId, actor.profile)] : []),
    communityRequestOptions(queryClient, original, signal), original.registry,
  )
  return { messageId: data.messageId, scope: data.scope, actors: data.actors.map((actor) => ({ userId: actor.userId, profilePresent: !!actor.profile })) }
}

export function useReactionDetails({
  messageId,
  open,
  userIds,
}: {
  messageId: string
  open: boolean
  userIds: readonly string[]
}) {
  const queryClient = useQueryClient()
  const uniqueUserIds = useMemo(() => [...new Set(userIds)], [userIds])
  const source = useCommunityViewSource(`reaction-details:${messageId}`, open)
  const attempted = useMemo(() => createStore({ queryClient, messageId, open, signal: source.signal, ids: new Set<string>() as ReadonlySet<string> }), [queryClient, messageId, open, source.signal])
  const query = useQuery({
    queryKey: communityKeys.reactionDetails(messageId),
    queryFn: ({ signal }) => loadReactionDetails(queryClient, messageId, signal),
    enabled: open, subscribed: open,
    staleTime: 5 * 60_000,
  })
  const { data, isFetching, refetch } = query

  const profileIds = useMemo(() => data?.actors.map((actor) => actor.userId) ?? [], [data])
  const profiles = useCanonicalProfilesByUserId(profileIds)
  useEffect(() => {
    const current = new Set(uniqueUserIds)
    attempted.setState((state) => ({ ...state, ids: new Set([...state.ids].filter((id) => current.has(id))) }))
    if (!open || !data || isFetching) return
    const known = new Set(data.actors.map((actor) => actor.userId))
    const unknown = uniqueUserIds.filter((id) => !known.has(id) && !attempted.get().ids.has(id))
    if (!unknown.length) return
    attempted.setState((state) => ({ ...state, ids: new Set([...state.ids, ...unknown]) }))
    const original = source.capture()
    const timer = setTimeout(() => {
      try { original() } catch { return }
      void refetch({ cancelRefetch: false }).catch(() => undefined)
    }, 100)
    return () => clearTimeout(timer)
  }, [data, isFetching, open, refetch, uniqueUserIds, attempted, source.signal, source])
  const projection: ReactionDetailsEnvelope | undefined = data ? { ...data, actors: data.actors.map((actor) => {
    const profile = profiles.get(actor.userId)
    return { userId: actor.userId, profile: actor.profilePresent && profile ? { id: actor.userId, name: profile.name ?? "", discriminator: profile.discriminator ?? "", avatar: profile.avatar ?? "", avatarVersion: profile.avatarVersion ?? 0 } : null }
  }) } : undefined
  return { ...query, data: projection }
}
