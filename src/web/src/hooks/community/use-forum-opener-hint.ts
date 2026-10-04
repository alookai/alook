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
import { conversationReadRetryPolicy, withConversationReadDeadline } from "@/lib/community/conversation-read"

export function useForumOpenerHint(
  serverId: string,
  messageId: string | null | undefined,
  enabled: boolean,
) {
  const active = enabled && !!messageId
  const registry = useOptionalCommunityDbRegistry()
  const canonicalMessages = useCanonicalMessagesById()
  const queryClient = useQueryClient()
  const queryKey = communityKeys.message(messageId ?? "__none__")
  const query = useQuery<{ id: string }>({
    queryKey,
    queryFn: ({ signal }) => withConversationReadDeadline(signal, async (readSignal) => {
      const token = captureCommunityLiveSnapshotToken(queryClient)
      await token.registry!.ready
      assertCommunityLiveSnapshotTokenCurrent(queryClient, token, readSignal)
      const message = await apiFetch<{
        id: string
        content: string
        seq: number
        channelId: string
        type: "chat" | "system"
      }>(
        `/api/community/messages/${messageId}`,
        communityRequestOptions(queryClient, token, readSignal),
      )
      publishCommunityMessages(queryClient, {
        channelId: message.channelId,
        messages: [message],
        proof: { token, signal: readSignal },
      })
      return {
        id: message.id,
      }
    }),
    enabled: active,
    staleTime: Infinity,
    gcTime: 5 * 60 * 1000,
    retry: conversationReadRetryPolicy(queryClient.defaultQueryOptions({ queryKey }).retry),
    networkMode: "always",
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
