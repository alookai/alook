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
  isLoading: boolean
} {
  const query = useQuery({
    queryKey: communityKeys.channelRefDirectory(),
    queryFn: channelRefDirectoryQueryFn,
    enabled,
    staleTime: Infinity,
    refetchOnReconnect: true,
  })
  return {
    directory: query.data ?? EMPTY_DIRECTORY,
    isLoading: enabled && query.isLoading,
  }
}
