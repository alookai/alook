"use client"

import { useQuery } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import type { ChannelRefDirectory } from "@/lib/community/channel-ref"

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
  const query = useQuery<ChannelRefDirectory>({
    queryKey: communityKeys.channelRefDirectory(),
    queryFn: channelRefDirectoryQueryFn,
    enabled,
    staleTime: Infinity,
    refetchOnReconnect: true,
    retry: false,
  })
  const isResolved = query.data !== undefined
  return {
    directory: query.data ?? EMPTY_DIRECTORY,
    isResolved,
    isLoading: enabled && !isResolved && query.isFetching,
    isError: enabled && !isResolved && query.isError,
    refetch: query.refetch,
  }
}
