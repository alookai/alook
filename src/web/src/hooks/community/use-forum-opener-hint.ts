"use client"

import { useQuery, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import type { ForumOpenerHint } from "@/hooks/community/use-forum-sidebar-threads"

export function useForumOpenerHint(
  serverId: string,
  messageId: string | null | undefined,
  enabled: boolean,
) {
  const active = enabled && !!messageId
  const queryClient = useQueryClient()
  const queryKey = communityKeys.forumOpenerHint(serverId, messageId ?? "__none__")
  const cached = queryClient.getQueryData<ForumOpenerHint>(queryKey)
  return useQuery<ForumOpenerHint>({
    queryKey,
    queryFn: async () => {
      const message = await apiFetch<{
        id: string
        content: string
        seq: number
        channelId: string
      }>(
        `/api/community/messages/${messageId}`,
      )
      return {
        id: message.id,
        content: message.content,
        seq: message.seq,
        channelId: message.channelId,
      }
    },
    enabled: active,
    staleTime: cached?.seq === undefined ? 0 : Infinity,
    gcTime: 5 * 60 * 1000,
  })
}
