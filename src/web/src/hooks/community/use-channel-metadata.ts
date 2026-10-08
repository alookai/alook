"use client"

import { useEffect, useMemo } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { channelMetadataOptions, isChannelMetadataTokenCurrent } from "./channel-metadata"
import { startChannelRouteVerification } from "./channel-route-verification"
import { useRouteChannelProjection } from "@/lib/community-db/projections"
import { useCommunityWsStore } from "@/stores/community/ws"
import { communityKeys } from "@/lib/query-keys"
import { useCommunityRuntime } from "@/stores/community/runtime"

import { useConversationReadRetry } from "./use-conversation-read-retry"

type ChannelReadingStatus = "no-target" | "pending" | "readable" | "denied" | "unresolved" | "retryable-error"

export function useChannelMetadata(serverId: string | null, channelId: string | undefined) {
  const queryClient = useQueryClient()
  const runtime = useCommunityRuntime()
  const accessEpoch = useCommunityWsStore((state) => state.accessEpoch)
  const accountEpoch = useCommunityWsStore((state) => state.profileAccountEpoch)
  const viewerId = useCommunityWsStore((state) => state.profileViewerId)
  const generation = useCommunityWsStore((state) => channelId ? state.channelAccessScopes.get(channelId)?.generation ?? 0 : 0)
  const revoked = useCommunityWsStore(() => !!channelId && runtime.ws.actions.isChannelAccessRevoked(channelId, serverId))
  const canonical = useRouteChannelProjection(channelId ?? null)
  const options = channelMetadataOptions(queryClient, serverId, channelId ?? "__none__")
  const query = useQuery({ ...options, enabled: !!channelId && !revoked,
    retry: serverId === null ? false : options.retry, retryOnMount: false,
    refetchOnReconnect: false, refetchOnWindowFocus: false })
  const entry = useMemo(() => {
    const resource = queryClient.getQueryCache().find({ queryKey: communityKeys.channelMeta(serverId, channelId ?? "__none__"), exact: true })!
    return { resource, revoked: !!channelId && runtime.ws.actions.isChannelAccessRevoked(channelId, serverId) && !runtime.ws.get().revokedServerIds.has(serverId ?? ""),
      errors: resource.state.errorUpdateCount, updates: resource.state.dataUpdateCount }
  }, [channelId, queryClient, runtime, serverId])
  useEffect(() => {
    if (!channelId || !entry.revoked) return
    void startChannelRouteVerification(queryClient, serverId, channelId).catch(() => undefined)
  }, [channelId, entry, queryClient, serverId])
  useEffect(() => {
    if (!channelId || revoked || query.data === undefined
      || query.data.identityProof && isChannelMetadataTokenCurrent(query.data.identityProof) && query.data.readProof && isChannelMetadataTokenCurrent(query.data.readProof)) return
    if (queryClient.getQueryState(communityKeys.channelMeta(serverId, channelId))?.fetchStatus === "fetching") return
    void queryClient.invalidateQueries({ queryKey: communityKeys.channelMeta(serverId, channelId), exact: true })
  }, [accessEpoch, accountEpoch, viewerId, generation, channelId, revoked, query.data, queryClient, serverId])
  const retry = useConversationReadRetry(query, queryClient, [serverId, channelId, viewerId, accountEpoch, accessEpoch, generation])
  const identityKnown = !!canonical && canonical.id === channelId && canonical.serverId === serverId && !canonical.pending
  const resource = queryClient.getQueryCache().find({ queryKey: options.queryKey, exact: true })!
  const replaced = resource !== entry.resource
  const failed = query.isError && (!entry.revoked || replaced || resource.state.errorUpdateCount > entry.errors)
  const denied = failed && typeof query.error === "object" && query.error !== null && "status" in query.error
    && (query.error.status === 403 || query.error.status === 404)
    || revoked && (!entry.revoked || !query.isFetching && !failed && (replaced || resource.state.dataUpdateCount > entry.updates))
  const isArchived = identityKnown && canonical.archived && !!query.data?.identityProof && isChannelMetadataTokenCurrent(query.data.identityProof)
  const canRead = identityKnown && !revoked && !denied && !isArchived && query.data?.id === channelId
    && !!query.data.readProof && isChannelMetadataTokenCurrent(query.data.readProof)
  const status: ChannelReadingStatus = !channelId ? "no-target" : denied || isArchived ? "denied"
    : canRead ? "readable" : (failed || retry.retrying) && retry.failed ? "retryable-error"
    : query.isFetching || entry.revoked && revoked ? "pending" : "unresolved"

  const data = useMemo(() => identityKnown ? { ...canonical, serverId,
    createdAt: canonical.createdAt ?? "", name: canonical.name ?? "",
    verifiedEpoch: query.data?.identityProof?.accessEpoch ?? -1,
    identityProof: query.data?.identityProof, readProof: query.data?.readProof,
    parentChannelId: canonical.parentChannelId ?? null, parentMessageId: canonical.parentMessageId ?? null,
    creatorId: canonical.creatorId ?? null, lastMessageAt: canonical.lastMessageAt ?? null }
    : undefined, [canonical, identityKnown, query.data, serverId])
  return { ...query, data, status, identityKnown, canRead, isVerified: canRead, isArchived, denied, revoked, canonical, retry: retry.retry, retrying: retry.retrying }
}
