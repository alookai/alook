"use client"

import { useQuery, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import {
  useCanonicalMessagesById,
  useOptionalCommunityDbRegistry,
} from "@/lib/community-db/projections"
import {
  captureCommunityLiveSnapshotToken,
  publishCommunityMessages,
  assertCommunityLiveSnapshotTokenCurrent,
} from "@/lib/community-db/sync"
import { communityRequestOptions } from "@/lib/community/account-cache-lifecycle"

export function useForumOpenerHint(
  serverId: string,
  messageId: string | null | undefined,
  enabled: boolean,
) {
  const active = enabled && !!messageId
  const registry = useOptionalCommunityDbRegistry()
  const canonicalMessages = useCanonicalMessagesById()
  const queryClient = useQueryClient()
  const query = useQuery<{ id: string }>({
    queryKey: communityKeys.message(messageId ?? "__none__"),
    queryFn: async ({ signal }) => {
      const token = captureCommunityLiveSnapshotToken(queryClient)
      await token.registry!.ready
      assertCommunityLiveSnapshotTokenCurrent(queryClient, token, signal)
      const message = await apiFetch<{
        id: string
        content: string
        seq: number
        channelId: string
        type: "chat" | "system"
      }>(
        `/api/community/messages/${messageId}`,
        communityRequestOptions(queryClient, token, signal),
      )
      publishCommunityMessages(queryClient, {
        channelId: message.channelId,
        messages: [message],
        proof: { token, signal },
      })
      return {
        id: message.id,
      }
    },
    enabled: active,
    staleTime: Infinity,
    gcTime: 5 * 60 * 1000,
  })
  const canonical = messageId ? canonicalMessages?.get(messageId) : undefined
  const data = canonical && typeof canonical.content === "string"
    ? {
        id: canonical.id,
        content: canonical.content,
        ...(canonical.seq === undefined ? {} : { seq: canonical.seq }),
      }
    : undefined
  void serverId
  return { ...query, data: registry ? data : undefined, isLoading: query.isLoading && data === undefined }
}
