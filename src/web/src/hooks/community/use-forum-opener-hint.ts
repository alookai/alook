"use client"

import { useQuery, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import type { ForumOpenerHint } from "@/hooks/community/use-forum-sidebar-threads"
import {
  useCanonicalMessagesById,
  useOptionalCommunityDbRegistry,
} from "@/lib/community-db/projections"
import {
  captureCommunityLiveSnapshotToken,
  publishCommunityMessages,
} from "@/lib/community-db/sync"

export function useForumOpenerHint(
  serverId: string,
  messageId: string | null | undefined,
  enabled: boolean,
) {
  const active = enabled && !!messageId
  const registry = useOptionalCommunityDbRegistry()
  const canonicalMessages = useCanonicalMessagesById()
  const queryClient = useQueryClient()
  const query = useQuery<ForumOpenerHint>({
    queryKey: communityKeys.message(messageId ?? "__none__"),
    queryFn: async ({ signal }) => {
      const token = captureCommunityLiveSnapshotToken(queryClient)
      const message = await apiFetch<{
        id: string
        content: string
        seq: number
        channelId: string
        type: "chat" | "system"
      }>(
        `/api/community/messages/${messageId}`,
        { signal },
      )
      publishCommunityMessages(queryClient, {
        channelId: message.channelId,
        messages: [message],
        proof: { token, signal },
      })
      return {
        id: message.id,
        content: message.content,
        seq: message.seq,
        channelId: message.channelId,
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
  return registry
    ? { ...query, data, isLoading: query.isLoading && data === undefined }
    : query
}
