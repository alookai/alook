"use client"

import { QueryObserver, type QueryClient } from "@tanstack/react-query"
import { useCallback } from "react"
import { channelMetadataOptions, captureChannelMetadataToken, isChannelMetadataTokenCurrent } from "./channel-metadata"
import { useChannelMetadata } from "./use-channel-metadata"
import {
  assertCommunityLiveSnapshotTokenCurrent,
  captureCommunityLiveSnapshotToken,
} from "@/lib/community-db/sync"

export type DmRouteVerification = "present" | "missing" | "denied"
type DmRouteVerificationStatus = "idle" | "pending" | "present" | "missing" | "error"
export type DmRouteVerificationResult = {
  status: DmRouteVerificationStatus
  retry: () => void
  retrying: boolean
}

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
  const token = captureCommunityLiveSnapshotToken(queryClient)
  try {
    const cached = queryClient.getQueryData<{ verification?: ReturnType<typeof captureChannelMetadataToken> }>(options.queryKey)
    await queryClient.query({ ...options,
      staleTime: cached?.verification && isChannelMetadataTokenCurrent(cached.verification) ? Infinity : 0, select: undefined })
    return "present"
  } catch (error) {
    if (classifyDmRouteAuthorityError(error) === "denied") {
      assertCommunityLiveSnapshotTokenCurrent(queryClient, {
        ...token, accessEpoch: captureCommunityLiveSnapshotToken(queryClient).accessEpoch,
      }, undefined)
      return "denied"
    }
    assertCommunityLiveSnapshotTokenCurrent(queryClient, token, undefined)
    throw error
  } finally {
    release()
  }
}

export function useDmRouteVerification(
  dmId: string | undefined,
): DmRouteVerificationResult {
  const verification = useChannelMetadata(null, dmId)
  const retry = useCallback(() => {
    if (!dmId || verification.fetchStatus === "fetching") return
    void verification.refetch({ cancelRefetch: false })
  }, [dmId, verification])
  let status: DmRouteVerificationStatus = "pending"
  if (!dmId) status = "idle"
  else if (classifyDmRouteAuthorityError(verification.error) === "denied" || verification.data?.archived || verification.canonical?.archived) status = "missing"
  else if (verification.isVerified && verification.data?.type === "dm") status = "present"
  else if (verification.isError) status = "error"

  return { status, retry, retrying: verification.fetchStatus === "fetching" }
}
