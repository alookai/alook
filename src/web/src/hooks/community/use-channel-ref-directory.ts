"use client"

import {
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import type { ChannelRefDirectory } from "@/lib/community/channel-ref"
import {
  useChannelRefDirectoryProjection,
  useOptionalCommunityDbRegistry,
} from "@/lib/community-db/projections"
import {
  captureCommunityLiveSnapshotToken,
  publishCommunityChannelDirectory,
} from "@/lib/community-db/sync"

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
  const registry = useOptionalCommunityDbRegistry()
  const queryClient = useQueryClient()
  const dbDirectory = useChannelRefDirectoryProjection()
  const query = useQuery<ChannelRefDirectory>({
    queryKey: communityKeys.channelRefDirectory(),
    // This account-scoped directory warms every composer, so its owner is the
    // QueryClient rather than the popup observer that happened to start it.
    // Let an in-flight request finish across popup/route unmounts; the live
    // snapshot token still rejects account/access changes before publication.
    queryFn: async () => {
      const token = captureCommunityLiveSnapshotToken(queryClient)
      const directory = await channelRefDirectoryQueryFn()
      publishCommunityChannelDirectory(queryClient, {
        directory,
        proof: { token, signal: undefined },
      })
      return directory
    },
    enabled,
    staleTime: Infinity,
    refetchOnReconnect: true,
    retry: false,
  })
  const directory = registry
    ? dbDirectory ?? EMPTY_DIRECTORY
    : query.data ?? EMPTY_DIRECTORY
  const hasCanonicalChannels = dbDirectory?.some((server) => server.channels.length > 0) ?? false
  const isResolved = registry
    ? hasCanonicalChannels || (query.isSuccess && !query.isFetching)
    : query.data !== undefined
  return {
    directory: isResolved ? directory : EMPTY_DIRECTORY,
    isResolved,
    // Enabling the query and React Query publishing `isFetching` are separate
    // renders. Keep the unresolved surface pending across that handoff instead
    // of briefly exposing a false empty state.
    isLoading: enabled && !isResolved && !query.isError,
    isError: enabled && !isResolved && query.isError,
    refetch: query.refetch,
  }
}
