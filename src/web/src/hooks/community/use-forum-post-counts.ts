"use client"

import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityRequestOptions } from "@/lib/community/account-cache-lifecycle"
import { captureCommunityLiveSnapshotToken, assertCommunityLiveSnapshotTokenCurrent } from "@/lib/community-db/sync"
import { communityKeys } from "@/lib/query-keys"
import { useCommunityOnlineAccount } from "./community-origin"
import { forumPostCountsReadSchema } from "@/lib/community/page-list-persistence"

export function refreshForumPostCounts(queryClient: QueryClient, serverId: string) {
  const queryKey = communityKeys.forumPostCounts(serverId)
  void queryClient.cancelQueries({ queryKey }).then(() =>
    queryClient.invalidateQueries({ queryKey }),
  ).catch(() => undefined)
}

export const forumPostCountsQueryFn = (serverId: string, queryClient: QueryClient) =>
  async ({ signal }: { signal?: AbortSignal } = {}) => {
    const token = captureCommunityLiveSnapshotToken(queryClient)
    assertCommunityLiveSnapshotTokenCurrent(queryClient, token, signal)
    const result = forumPostCountsReadSchema.parse(await apiFetch(`/api/community/servers/${serverId}/forum-counts`,
      communityRequestOptions(queryClient, token, signal)))
    assertCommunityLiveSnapshotTokenCurrent(queryClient, token, signal)
    if (result.serverId !== serverId) throw new Error("Forum count scope mismatch")
    return result.counts
  }

export function useForumPostCounts(serverId: string, enabled: boolean) {
  const queryClient = useQueryClient()
  const online = useCommunityOnlineAccount()
  return useQuery({
    queryKey: communityKeys.forumPostCounts(serverId),
    enabled: enabled && online && !!serverId,
    staleTime: 30_000,
    retry: 1,
    refetchOnWindowFocus: true,
    throwOnError: false,
    queryFn: forumPostCountsQueryFn(serverId, queryClient),
  })
}
