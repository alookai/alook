"use client"

import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import type { Msg } from "@/components/community/_types"

/**
 * Fetches a single hydrated message by id — the payload shape returned by
 * `GET /api/community/messages/:id`. Mirrors the per-message body inside the
 * channel/DM list responses.
 *
 * Used by the thread opener block (parent message pinned atop a thread) and
 * anywhere else that needs a live view of one message. Keyed under
 * `communityKeys.message(id)` so edit/reaction/pin mutations can invalidate
 * (or `setQueryData`-patch) exactly one entry and every viewer of it updates
 * without a page reload.
 *
 * Pass a falsy id when there's nothing to load — the query stays disabled.
 */
export type OpenerPayload = {
  id: string
  authorId: string
  authorName: string
  authorAvatar: string
  content: string
  type?: "system"
  createdAt: string
  attachments?: Msg["attachments"]
  embeds?: Msg["embeds"]
  reactions?: Msg["reactions"]
}

export const messageQueryFn = (messageId: string) => () =>
  apiFetch<OpenerPayload>(`/api/community/messages/${messageId}`)

export function useMessage(
  messageId: string | null | undefined,
): UseQueryResult<OpenerPayload> & { message: OpenerPayload | null } {
  const enabled = !!messageId
  const query = useQuery({
    queryKey: enabled ? communityKeys.message(messageId!) : communityKeys.message("__none__"),
    queryFn: enabled
      ? messageQueryFn(messageId!)
      : (() => Promise.reject(new Error("disabled"))),
    enabled,
    // Quick tab-switches shouldn't hammer the endpoint; 30s window is plenty
    // for the "opener stays live via mutation invalidation" contract.
    staleTime: 30_000,
  })
  return {
    ...query,
    message: query.data ?? null,
  }
}
