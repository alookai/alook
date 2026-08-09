"use client"

import { useQuery } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import type { ForumOpenerHint } from "@/hooks/community/use-forum-sidebar-threads"

export function useForumOpenerHint(
  serverId: string,
  messageId: string | null | undefined,
  enabled: boolean,
) {
  const active = enabled && !!messageId
  return useQuery<ForumOpenerHint>({
    queryKey: communityKeys.forumOpenerHint(serverId, messageId ?? "__none__"),
    queryFn: async () => {
      const message = await apiFetch<{ id: string; content: string }>(
        `/api/community/messages/${messageId}`,
      )
      return { id: message.id, content: message.content }
    },
    enabled: active,
    staleTime: Infinity,
    gcTime: 5 * 60 * 1000,
  })
}
