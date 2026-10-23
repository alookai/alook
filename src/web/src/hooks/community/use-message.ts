"use client"
import { useSelector } from "@tanstack/react-store"


import { useEffect, useMemo } from "react"
import {
  useQuery,
  useQueryClient,
  queryOptions,
  type QueryClient,
  type QueryFunctionContext,
  type UseQueryResult,
} from "@tanstack/react-query"
import { apiFetchCommunity } from "@/lib/community/account-cache-lifecycle"
import { COMMUNITY_CONTRACT_HEADER, COMMUNITY_RESOURCE_CONTRACT_VERSION } from "@alook/shared"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { communityKeys } from "@/lib/query-keys"
import type { MessageInput, MessagesPage, Msg } from "@/lib/community/models/message"
import { presentCanonicalMessage } from "@/lib/community/message-wire"
import {
  useCanonicalMessagesById,
  useOptionalCommunityDbRegistry,
} from "@/lib/community-db/projections"
import {
  rememberMessageAccessScope,
  type MessageAccessScope,
} from "@/lib/community-db/message-access-scope"
import { accountUnreadAllowsAccess, getActiveAccountUnreadProjection } from "./account-unread-projection"
import { conversationReadRetryPolicy, withConversationReadDeadline } from "@/lib/community/conversation-read"
import {
  captureCommunityLiveSnapshotToken,
  assertCommunityLiveSnapshotTokenCurrent,
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
  & Pick<Msg, "replyTo" | "attachments" | "embeds" | "reactions" | "seq"> & { channelId?: string }

export const messageQueryFn = (
  messageId: string,
  queryClient: QueryClient,
  channelId?: string,
) => (context: QueryFunctionContext) => withConversationReadDeadline(context.signal, async readSignal => {
  if (context.client !== queryClient) throw new DOMException("Mismatched message query owner", "AbortError")
  const token = captureCommunityLiveSnapshotToken(queryClient, channelId)
  const message = await apiFetchCommunity<MessageInput>(
    `/api/community/messages/${messageId}`,
    { signal: readSignal, headers: { [COMMUNITY_CONTRACT_HEADER]: String(COMMUNITY_RESOURCE_CONTRACT_VERSION) } }, token,
  )
  const publishChannelId = message.channelId ?? channelId
  if (publishChannelId) {
    publishCommunityMessages(queryClient, {
      channelId: publishChannelId,
      messages: [message],
      proof: { token, signal: readSignal },
    })
  }
  return message.id
})

function messageQueryOptions(queryClient: QueryClient, messageId: string, channelId?: string) {
  return queryOptions({
    queryKey: communityKeys.message(messageId),
    queryFn: messageQueryFn(messageId, queryClient, channelId),
    staleTime: 30_000,
    retry: conversationReadRetryPolicy(queryClient.defaultQueryOptions({ queryKey: communityKeys.message(messageId) }).retry),
    networkMode: "always",
  })
}

export async function prefetchCommunityMessage(queryClient: QueryClient, messageId: string, scope: MessageAccessScope) {
  const registry = getCommunityDbRegistry(queryClient)
  if (!registry?.runtime.lifecycle.get().active
    || !accountUnreadAllowsAccess(getActiveAccountUnreadProjection(queryClient).state.get(), scope)) return
  rememberMessageAccessScope(queryClient, messageId, scope)
  if (registry.collections.messages.get(messageId)?.resourceComplete) return
  await queryClient.query({ ...messageQueryOptions(queryClient, messageId, scope.channelId), staleTime: 0, select: undefined })
}

export async function prefetchCommunityLatestMessage(queryClient: QueryClient, channelId: string) {
  const token = captureCommunityLiveSnapshotToken(queryClient, channelId)
  const registry = token.registry
  if (!registry?.runtime.lifecycle.get().active) return
  const scope = { channelId, serverId: registry.collections.channels.get(channelId)?.serverId }
  if (!accountUnreadAllowsAccess(getActiveAccountUnreadProjection(queryClient).state.get(), scope)) return
  const queryKey = communityKeys.channelLatestMessage(channelId)
  await queryClient.cancelQueries({ queryKey, exact: true })
  assertCommunityLiveSnapshotTokenCurrent(queryClient, token, undefined)
  await queryClient.query({
    queryKey,
    staleTime: 0,
    retry: conversationReadRetryPolicy(queryClient.defaultQueryOptions({ queryKey }).retry),
    networkMode: "always",
    queryFn: ({ signal }) => withConversationReadDeadline(signal, async (readSignal) => {
      const page = await apiFetchCommunity<MessagesPage>(
        `/api/community/channels/${channelId}/messages?limit=1`,
        { signal: readSignal, headers: { [COMMUNITY_CONTRACT_HEADER]: String(COMMUNITY_RESOURCE_CONTRACT_VERSION) } }, token,
      )
      publishCommunityMessages(queryClient, { channelId, messages: page.messages, proof: { token, signal: readSignal } })
      return page.messages[0]?.id ?? null
    }),
    select: undefined,
  })
}

export function findCachedMessage(
  queryClient: QueryClient,
  messageId: string,
): OpenerPayload | undefined {
  const message = getCanonicalCommunityMessages(queryClient).find((row) => row.id === messageId)
  if (!message?.authorId || !message.createdAt) return undefined
  const view = presentCanonicalMessage(message)
  return {
    ...view,
    authorId: message.authorId,
    authorName: message.authorName ?? "Deleted user",
    authorAvatar: view.authorAvatar ?? "",
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
    ...messageQueryOptions(queryClient, enabled ? messageId! : "__none__", accessScope?.channelId),
    queryFn: enabled
      ? messageQueryFn(messageId!, queryClient, accessScope?.channelId)
      : (() => Promise.reject(new Error("disabled"))),
    enabled,
    placeholderData,
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
