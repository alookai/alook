"use client"
import { useSelector } from "@tanstack/react-store"


import { useEffect, useMemo } from "react"
import {
  useQuery,
  useQueryClient,
  type QueryClient,
  type QueryFunctionContext,
  type UseQueryResult,
} from "@tanstack/react-query"
import { apiFetchCommunity } from "@/lib/community/account-cache-lifecycle"
import { communityKeys } from "@/lib/query-keys"
import type { Msg } from "@/lib/community/models/message"
import {
  useCanonicalMessagesById,
  useOptionalCommunityDbRegistry,
} from "@/lib/community-db/projections"
import {
  rememberMessageAccessScope,
  type MessageAccessScope,
} from "@/lib/community-db/message-access-scope"
import { accountUnreadAllowsAccess, getActiveAccountUnreadProjection } from "./account-unread-projection"
import {
  captureCommunityLiveSnapshotToken,
  publishCommunityMessages,
  getCanonicalCommunityMessages,
} from "@/lib/community-db/sync"

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
export type OpenerPayload = Required<Pick<Msg, "id" | "authorId" | "authorName" | "authorAvatar" | "authorAvatarVersion" | "content" | "type" | "createdAt">>
  & Pick<Msg, "replyTo" | "attachments" | "embeds" | "reactions"> & { channelId?: string }

export const messageQueryFn = (
  messageId: string,
  queryClient: QueryClient,
  channelId?: string,
) => async (context: QueryFunctionContext) => {
  if (context.client !== queryClient) throw new DOMException("Mismatched message query owner", "AbortError")
  const token = captureCommunityLiveSnapshotToken(queryClient, channelId)
  const message = await apiFetchCommunity<OpenerPayload>(
    `/api/community/messages/${messageId}`,
    context.signal ? { signal: context.signal } : undefined, token,
  )
  const publishChannelId = message.channelId ?? channelId
  if (publishChannelId) {
    publishCommunityMessages(queryClient, {
      channelId: publishChannelId,
      messages: [{ ...message, attachments: message.attachments ?? [], embeds: message.embeds ?? [],
        reactions: message.reactions ?? [], replyTo: message.replyTo }],
      proof: { token, signal: context.signal },
    })
  }
  return message.id
}

export function findCachedMessage(
  queryClient: QueryClient,
  messageId: string,
): OpenerPayload | undefined {
  const message = getCanonicalCommunityMessages(queryClient).find((row) => row.id === messageId)
  if (!message?.authorId || !message.createdAt) return undefined
  return {
    ...message,
    authorId: message.authorId,
    authorName: message.authorName ?? "Deleted user",
    authorAvatar: message.authorAvatar ?? "",
    authorAvatarVersion: message.authorAvatarVersion ?? 0,
    content: message.content ?? "",
    createdAt: message.createdAt,
  }

}

export function useMessage(
  messageId: string | null | undefined,
  accessScope?: MessageAccessScope,
): UseQueryResult<string> & { message: OpenerPayload | null } {
  const registry = useOptionalCommunityDbRegistry()
  const selectedIds = useMemo(() => messageId ? [messageId] : [], [messageId])
  const canonicalMessages = useCanonicalMessagesById(selectedIds)
  const queryClient = useQueryClient()
  const accessProjection = useMemo(
    () => getActiveAccountUnreadProjection(queryClient),
    [queryClient],
  )
  const accessAllowed = useSelector(accessProjection.state, (state) => !accessScope || accountUnreadAllowsAccess(state, accessScope))
  const enabled = !!messageId && accessAllowed
  useEffect(() => {
    if (!messageId || !accessScope || !accessAllowed) return
    rememberMessageAccessScope(queryClient, messageId, accessScope)
  }, [accessAllowed, accessScope, messageId, queryClient])
  const placeholderData = useMemo(
    () => messageId && accessAllowed ? findCachedMessage(queryClient, messageId)?.id : undefined,
    [accessAllowed, messageId, queryClient],
  )
  const query = useQuery({
    queryKey: enabled ? communityKeys.message(messageId!) : communityKeys.message("__none__"),
    queryFn: enabled
      ? messageQueryFn(messageId!, queryClient, accessScope?.channelId)
      : (() => Promise.reject(new Error("disabled"))),
    enabled,
    placeholderData,
    // Quick tab-switches shouldn't hammer the endpoint; 30s window is plenty
    // for the "opener stays live via mutation invalidation" contract.
    staleTime: 30_000,
  })
  const canonical = messageId ? canonicalMessages?.get(messageId) : undefined
  return {
    ...query,
    message: accessAllowed
      ? registry
        ? (canonical as OpenerPayload | undefined) ?? null
        : null
      : null,
  }
}
