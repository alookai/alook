"use client"

import { useEffect, useMemo } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { channelMetadataOptions, isChannelMetadataTokenCurrent } from "./channel-metadata"
import { useRouteChannelProjection } from "@/lib/community-db/projections"
import { useCommunityWsStore } from "@/stores/community/ws"
import { communityKeys } from "@/lib/query-keys"

export function useChannelMetadata(serverId: string | null, channelId: string | undefined) {
  const queryClient = useQueryClient()
  const accessEpoch = useCommunityWsStore((state) => state.accessEpoch)
  const accountEpoch = useCommunityWsStore((state) => state.profileAccountEpoch)
  const viewerId = useCommunityWsStore((state) => state.profileViewerId)
  const generation = useCommunityWsStore((state) => channelId
    ? state.channelAccessScopes.get(channelId)?.generation ?? 0 : 0)
  const revoked = useCommunityWsStore((state) => channelId
    ? state.isChannelAccessRevoked(channelId, serverId ?? undefined)
    : false)
  const canonical = useRouteChannelProjection(channelId ?? null)
  const options = channelMetadataOptions(queryClient, serverId, channelId ?? "__none__")
  const query = useQuery({
    ...options,
    enabled: !!channelId,
    retry: serverId === null ? false : options.retry,
    retryOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  })
  useEffect(() => {
    if (!channelId || query.data === undefined
      || (query.data.verification && isChannelMetadataTokenCurrent(query.data.verification))) return
    void queryClient.invalidateQueries({ queryKey: communityKeys.channelMeta(serverId, channelId), exact: true })
  }, [accessEpoch, accountEpoch, viewerId, generation, channelId, query.data, queryClient, serverId])
  const denied = typeof query.error === "object" && query.error !== null && "status" in query.error
    && (query.error.status === 403 || query.error.status === 404)
  const isVerified = !!query.data && query.data.id === channelId
    && query.data.serverId === serverId && query.data.verifiedEpoch === accessEpoch
    && !!query.data.verification && isChannelMetadataTokenCurrent(query.data.verification)
    && !revoked && !denied && !query.data.archived && !canonical?.archived && !canonical?.pending
  const data = useMemo(() => isVerified && canonical?.id === channelId && canonical.serverId === serverId
    ? { ...query.data!, ...canonical,
        parentChannelId: canonical.parentChannelId ?? null,
        parentMessageId: canonical.parentMessageId ?? null,
        creatorId: canonical.creatorId ?? null,
        lastMessageAt: canonical.lastMessageAt ?? null }
    : query.data, [canonical, channelId, isVerified, query.data, serverId])
  return { ...query, data, isVerified, denied, canonical }
}
