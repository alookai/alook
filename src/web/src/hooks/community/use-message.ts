"use client"
import { useSelector } from "@tanstack/react-store"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"


import { useEffect, useMemo } from "react"
import {
  useQuery,
  useQueryClient,
  type QueryClient,
  type QueryFunctionContext,
  type UseQueryResult,
} from "@tanstack/react-query"
import { apiFetchProfiles, messageProfilePatches } from "@/lib/community/profile-seed"
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
export type OpenerPayload = {
  id: string
  // Exact-message responses carry their owning surface so a hard-refresh can
  // publish an archived opener even when the route model has no parent hint.
  // Persisted list-window placeholders predate that response field.
  channelId?: string
  authorId: string
  authorName: string
  authorAvatar: string
  authorAvatarVersion: number
  content: string
  // Required, exhaustive (#12) — matches `mapMessageForApi`'s new output
  // shape (this payload is fed by that same endpoint, `GET /api/community/messages/:id`).
  type: "chat" | "system"
  createdAt: string
  replyTo?: Msg["replyTo"]
  attachments?: Msg["attachments"]
  embeds?: Msg["embeds"]
  reactions?: Msg["reactions"]
}

export const messageQueryFn = (
  messageId: string,
  queryClient: QueryClient,
  channelId?: string,
) => async (context: QueryFunctionContext) => {
  if (context.client !== queryClient) throw new DOMException("Mismatched message query owner", "AbortError")
  const token = captureCommunityLiveSnapshotToken(queryClient)
  const message = await apiFetchProfiles<OpenerPayload>(
    `/api/community/messages/${messageId}`,
    (message) => messageProfilePatches([message]),
    context.signal ? { signal: context.signal } : undefined, getCommunityDbRegistry(context.client),
  )
  const publishChannelId = message.channelId ?? channelId
  if (publishChannelId) {
    publishCommunityMessages(queryClient, {
      channelId: publishChannelId,
      messages: [message],
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
  const canonicalMessages = useCanonicalMessagesById()
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
