"use client"

import { useEffect, useMemo } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { channelMetadataOptions, isChannelMetadataTokenCurrent } from "./channel-metadata"
import { useRouteChannelProjection } from "@/lib/community-db/projections"
import { useCommunityWsStore } from "@/stores/community/ws"
import { communityKeys } from "@/lib/query-keys"
import { useCommunityRuntime } from "@/stores/community/runtime"

export function useChannelMetadata(serverId: string | null, channelId: string | undefined) {
  const queryClient = useQueryClient()
  const runtime = useCommunityRuntime()
  const accessEpoch = useCommunityWsStore((state) => state.accessEpoch)
  const accountEpoch = useCommunityWsStore((state) => state.profileAccountEpoch)
  const viewerId = useCommunityWsStore((state) => state.profileViewerId)
  const generation = useCommunityWsStore((state) => channelId
    ? state.channelAccessScopes.get(channelId)?.generation ?? 0 : 0)
  const revoked = useCommunityWsStore(() => channelId
    ? runtime.ws.actions.isChannelAccessRevoked(channelId, serverId ?? undefined)
    : false)
  const canonical = useRouteChannelProjection(channelId ?? null)
  const options = channelMetadataOptions(queryClient, serverId, channelId ?? "__none__")
  const query = useQuery({
    ...options,
    enabled: !!channelId && !revoked,
    retry: serverId === null ? false : options.retry,
    retryOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  })
  useEffect(() => {
    if (!channelId || revoked || query.data === undefined
      || (query.data.verification && isChannelMetadataTokenCurrent(query.data.verification))) return
    if (queryClient.getQueryState(communityKeys.channelMeta(serverId, channelId))?.fetchStatus === "fetching") return
    void queryClient.invalidateQueries({ queryKey: communityKeys.channelMeta(serverId, channelId), exact: true })
  }, [accessEpoch, accountEpoch, viewerId, generation, channelId, revoked, query.data, queryClient, serverId])
  const denied = typeof query.error === "object" && query.error !== null && "status" in query.error
    && (query.error.status === 403 || query.error.status === 404)
  const hasCurrentVerification = !!query.data && query.data.id === channelId
    && canonical?.serverId === serverId && query.data.verifiedEpoch === accessEpoch
    && !!query.data.verification && isChannelMetadataTokenCurrent(query.data.verification)
    && !revoked && !denied && !canonical?.pending
  const isArchived = hasCurrentVerification && !!canonical?.archived
  const isVerified = hasCurrentVerification && !canonical?.archived
  const data = useMemo(() => canonical && canonical.id === channelId && canonical.serverId === serverId
    ? { ...canonical,
        serverId,
        createdAt: canonical.createdAt ?? "",
        name: canonical.name ?? "",
        verifiedEpoch: query.data?.verifiedEpoch ?? -1,
        verification: query.data?.verification,
        historyVerification: query.data?.historyVerification,
        fullReadVerification: query.data?.fullReadVerification,
        parentChannelId: canonical.parentChannelId ?? null,
        parentMessageId: canonical.parentMessageId ?? null,
        creatorId: canonical.creatorId ?? null,
        lastMessageAt: canonical.lastMessageAt ?? null }
    : undefined, [canonical, channelId, query.data, serverId])
  return { ...query, data, isVerified, isArchived, denied, canonical }
}
