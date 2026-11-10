"use client"

import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query"
import { z } from "zod"
import { apiFetch } from "@/lib/api/client"
import { communityRequestOptions } from "@/lib/community/account-cache-lifecycle"
import { captureCommunityLiveSnapshotToken, assertCommunityLiveSnapshotTokenCurrent } from "@/lib/community-db/sync"
import { useOptionalCommunityDbRegistry } from "@/lib/community-db/projections"
import { useCommunityWsStore } from "@/stores/community/ws"
import { communityKeys } from "@/lib/query-keys"
import { useCommunityOnlineAccount } from "./community-origin"

const envelope = z.object({ serverId: z.string(), counts: z.record(z.string(), z.number().int().nonnegative()) })

export function refreshForumPostCounts(queryClient: QueryClient, serverId: string) {
  const queryKey = communityKeys.forumPostCounts(serverId)
  void queryClient.cancelQueries({ queryKey }).then(() =>
    queryClient.invalidateQueries({ queryKey }),
  ).catch(() => undefined)
}

export function useForumPostCounts(serverId: string, enabled: boolean) {
  const queryClient = useQueryClient()
  const registry = useOptionalCommunityDbRegistry()
  const online = useCommunityOnlineAccount()
  const accessEpoch = useCommunityWsStore(state => state.accessEpoch)
  return useQuery({
    queryKey: [...communityKeys.forumPostCounts(serverId), registry?.accountId, accessEpoch],
    enabled: enabled && online && !!serverId,
    staleTime: 30_000,
    retry: 1,
    refetchOnWindowFocus: true,
    throwOnError: false,
    queryFn: async ({ signal }) => {
      const token = captureCommunityLiveSnapshotToken(queryClient)
      assertCommunityLiveSnapshotTokenCurrent(queryClient, token, signal)
      const result = envelope.parse(await apiFetch(`/api/community/servers/${serverId}/forum-counts`,
        communityRequestOptions(queryClient, token, signal)))
      assertCommunityLiveSnapshotTokenCurrent(queryClient, token, signal)
      if (result.serverId !== serverId) throw new Error("Forum count scope mismatch")
      return result.counts
    },
  })
}
