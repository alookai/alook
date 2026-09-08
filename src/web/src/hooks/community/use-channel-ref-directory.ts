"use client"

import { useQuery } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import type { ChannelRefDirectory } from "@/lib/community/channel-ref"
import { structuralSnapshotDirectory } from "@/lib/community/structural-snapshot"
import { useStructuralSnapshot } from "./use-structural-snapshot"
import { useCommunityWsStore } from "@/stores/community/ws"

const EMPTY_DIRECTORY = Object.freeze([]) as unknown as ChannelRefDirectory

export const channelRefDirectoryQueryFn = async (): Promise<ChannelRefDirectory> => {
  const data = await apiFetch<{ directory: ChannelRefDirectory }>(
    "/api/community/users/me/channel-directory",
  )
  return data.directory
}

export function useChannelRefDirectory(enabled = true): {
  directory: ChannelRefDirectory
  isResolved: boolean
  isLoading: boolean
  isError: boolean
  refetch: ReturnType<typeof useQuery<ChannelRefDirectory>>["refetch"]
} {
  const accountId = useCommunityWsStore((state) => state.profileViewerId)
  const structuralSnapshot = useStructuralSnapshot(accountId)
  const query = useQuery<ChannelRefDirectory>({
    queryKey: communityKeys.channelRefDirectory(),
    queryFn: channelRefDirectoryQueryFn,
    enabled,
    staleTime: Infinity,
    refetchOnReconnect: true,
    retry: false,
  })
  const structuralDirectory = structuralSnapshotDirectory(structuralSnapshot)
  const directory = query.data ?? structuralDirectory
  // A server-list receipt creates rail identities before any server detail
  // tree has been loaded. An empty directory from that partial hint is not an
  // authoritative "no channels" result and must not suppress the live
  // directory's pending/error state.
  const hasStructuralChannels = structuralDirectory.some((server) => server.channels.length > 0)
  const isResolved = query.data !== undefined || hasStructuralChannels
  return {
    directory: isResolved ? directory : EMPTY_DIRECTORY,
    isResolved,
    isLoading: enabled && !isResolved && query.isFetching,
    isError: enabled && !isResolved && query.isError,
    refetch: query.refetch,
  }
}
