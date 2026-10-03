"use client"
import { communityRequestOptions } from "@/lib/community/account-cache-lifecycle"

import {
  useQuery,
  QueryObserver,
  useQueryClient,
} from "@tanstack/react-query"
import { apiFetch, type ApiRequestOptions } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import type { ChannelRefDirectory } from "@/lib/community/channel-ref"
import {
  useChannelRefDirectoryProjection,
} from "@/lib/community-db/projections"
import {
  captureCommunityLiveSnapshotToken,
  publishCommunityChannelDirectory,
} from "@/lib/community-db/sync"

const EMPTY_DIRECTORY = Object.freeze([]) as unknown as ChannelRefDirectory

export const channelRefDirectoryQueryFn = async (options: ApiRequestOptions): Promise<ChannelRefDirectory> => {
  const data = await apiFetch<{ directory: ChannelRefDirectory }>(
    "/api/community/users/me/channel-directory", options,
  )
  return data.directory
}

export function useChannelRefDirectory(enabled = true): {
  directory: ChannelRefDirectory
  isResolved: boolean
  isLoading: boolean
  isError: boolean
  refetch: ReturnType<typeof useQuery<string[]>>["refetch"]
} {
  const queryClient = useQueryClient()
  const dbDirectory = useChannelRefDirectoryProjection()
  const query = useQuery<string[]>({
    queryKey: communityKeys.channelRefDirectory(),
    queryFn: async ({ signal }) => {
      const observer = new QueryObserver<string[]>(queryClient, { queryKey: communityKeys.channelRefDirectory(), enabled: false })
      const release = observer.subscribe(() => {
        if (queryClient.getQueryState(communityKeys.channelRefDirectory())?.fetchStatus === "idle") {
          signal.removeEventListener("abort", release)
          release()
        }
      })
      signal.addEventListener("abort", release, { once: true })
      const token = captureCommunityLiveSnapshotToken(queryClient)
      const directory = await channelRefDirectoryQueryFn(communityRequestOptions(queryClient, token, signal))
      publishCommunityChannelDirectory(queryClient, {
        directory,
        proof: { token, signal },
      })
      return directory.map((server) => server.id)
    },
    enabled,
    staleTime: Infinity,
    refetchOnReconnect: true,
    retry: false,
  })
  const directory = dbDirectory ?? EMPTY_DIRECTORY
  const hasCanonicalChannels = dbDirectory?.some((server) => server.channels.length > 0) ?? false
  const isResolved = hasCanonicalChannels || (query.isSuccess && !query.isFetching)
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
