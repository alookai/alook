"use client"

import {
  useQuery,
  useQueryClient,
  type QueryFunctionContext,
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

export const channelRefDirectoryQueryFn = async (
  context: QueryFunctionContext = {} as QueryFunctionContext,
): Promise<ChannelRefDirectory> => {
  const data = context.signal
    ? await apiFetch<{ directory: ChannelRefDirectory }>(
        "/api/community/users/me/channel-directory",
        { signal: context.signal },
      )
    : await apiFetch<{ directory: ChannelRefDirectory }>(
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
    queryFn: async (context) => {
      const token = captureCommunityLiveSnapshotToken(queryClient)
      const directory = await channelRefDirectoryQueryFn(context)
      publishCommunityChannelDirectory(queryClient, {
        directory,
        proof: { token, signal: context.signal },
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
  const isResolved = registry
    ? (dbDirectory?.length ?? 0) > 0 || query.isSuccess
    : query.data !== undefined
  return {
    directory: isResolved ? directory : EMPTY_DIRECTORY,
    isResolved,
    isLoading: enabled && !isResolved && query.isFetching,
    isError: enabled && !isResolved && query.isError,
    refetch: query.refetch,
  }
}
