"use client"

import { QueryObserver, type QueryClient } from "@tanstack/react-query"
import { channelMetadataOptions, captureChannelMetadataToken, isChannelMetadataTokenCurrent } from "./channel-metadata"
import {
  assertCommunityLiveSnapshotTokenCurrent,
  captureCommunityLiveSnapshotToken,
} from "@/lib/community-db/sync"

export type DmRouteVerification = "present" | "missing" | "denied"

function classifyDmRouteAuthorityError(error: unknown): "denied" | "error" {
  const status = typeof error === "object" && error !== null && "status" in error
    ? error.status
    : undefined
  return status === 403 || status === 404 ? "denied" : "error"
}

function verificationOptions(queryClient: QueryClient, dmId: string) {
  return {
    ...channelMetadataOptions(queryClient, null, dmId),
    retry: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    retryOnMount: false,
  } as const
}

export async function startDmRouteVerification(
  queryClient: QueryClient,
  dmId: string,
): Promise<DmRouteVerification> {
  const options = verificationOptions(queryClient, dmId)
  const owner = new QueryObserver(queryClient, { ...options, enabled: false })
  const release = owner.subscribe(() => {})
  const token = captureCommunityLiveSnapshotToken(queryClient, dmId)
  try {
    const cached = queryClient.getQueryData<{ readProof?: ReturnType<typeof captureChannelMetadataToken> }>(options.queryKey)
    const resource = await queryClient.query({ ...options,
      staleTime: cached?.readProof && isChannelMetadataTokenCurrent(cached.readProof) ? Infinity : 0, select: undefined })
    return resource.readProof && isChannelMetadataTokenCurrent(resource.readProof) ? "present" : "denied"
  } catch (error) {
    if (classifyDmRouteAuthorityError(error) === "denied") {
      assertCommunityLiveSnapshotTokenCurrent(queryClient, {
        ...token, accessEpoch: captureCommunityLiveSnapshotToken(queryClient).accessEpoch, channelScopes: captureCommunityLiveSnapshotToken(queryClient).channelScopes,
      }, undefined)
      return "denied"
    }
    assertCommunityLiveSnapshotTokenCurrent(queryClient, token, undefined)
    throw error
  } finally {
    release()
  }
}
