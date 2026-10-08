"use client"

import { QueryObserver, type QueryClient } from "@tanstack/react-query"
import { channelMetadataOptions, isChannelMetadataTokenCurrent, type ChannelMetadataResource } from "./channel-metadata"
import {
  assertCommunityLiveSnapshotTokenCurrent,
  captureCommunityLiveSnapshotToken,
} from "@/lib/community-db/sync"

export type ChannelRouteVerification = "present" | "missing" | "denied"

export async function startChannelRouteVerification(
  queryClient: QueryClient,
  serverId: string | null,
  channelId: string,
): Promise<ChannelRouteVerification> {
  const metadata = channelMetadataOptions(queryClient, serverId, channelId)
  const options = { ...metadata, retry: serverId === null ? false : metadata.retry }
  let token = captureCommunityLiveSnapshotToken(queryClient, channelId)
  const ws = token.registry?.runtime.ws
  if (ws?.actions.isChannelAccessRevoked(channelId, serverId)
    && queryClient.getQueryState(options.queryKey)?.fetchStatus !== "fetching") {
    assertCommunityLiveSnapshotTokenCurrent(queryClient, token, undefined)
    ws.actions.beginChannelMembershipChange(serverId, channelId, { preserveRevocation: true })
    token = captureCommunityLiveSnapshotToken(queryClient, channelId)
  }
  const owner = new QueryObserver(queryClient, { ...options, enabled: false })
  const release = owner.subscribe(() => {})
  try {
    const cached = queryClient.getQueryData<ChannelMetadataResource>(options.queryKey)
    const resource = await queryClient.query({ ...options,
      staleTime: cached?.readProof && isChannelMetadataTokenCurrent(cached.readProof) ? Infinity : 0, select: undefined })
    return resource.readProof && isChannelMetadataTokenCurrent(resource.readProof) ? "present" : "denied"
  } catch (error) {
    const status = typeof error === "object" && error !== null && "status" in error ? error.status : undefined
    if (status === 403 || status === 404) {
      const current = captureCommunityLiveSnapshotToken(queryClient)
      assertCommunityLiveSnapshotTokenCurrent(queryClient, {
        ...token, accessEpoch: current.accessEpoch, channelScopes: current.channelScopes,
      }, undefined)
      return "denied"
    }
    assertCommunityLiveSnapshotTokenCurrent(queryClient, token, undefined)
    throw error
  } finally {
    release()
  }
}
