"use client"

import { useMemo, useSyncExternalStore } from "react"
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
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { getActiveAccountUnreadProjection } from "./account-unread-projection"
import {
  captureCommunityLiveSnapshotToken,
  reconcileCanonicalEmbeddedMessages,
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

export type MessageAccessScope = {
  channelId?: string
  serverId?: string | null
}

export const messageQueryFn = (
  messageId: string,
  queryClient?: QueryClient,
  channelId?: string,
) => async (context: QueryFunctionContext = {} as QueryFunctionContext) => {
  const token = queryClient ? captureCommunityLiveSnapshotToken(queryClient) : null
  const message = await apiFetchProfiles<OpenerPayload>(
    `/api/community/messages/${messageId}`,
    (message) => messageProfilePatches([message]),
    context.signal ? { signal: context.signal } : undefined,
  )
  if (message.id !== messageId) {
    const error = new Error(`Expected message ${messageId}, received ${message.id}`)
    error.name = "CommunityMessageProtocolError"
    throw error
  }
  const publishChannelId = message.channelId ?? channelId
  if (queryClient && publishChannelId && token) {
    // The direct-message lookup hydrates the row itself but does not own
    // parent-channel thread metadata. Publish it as a partial entity patch so
    // opening a child split cannot erase the opener's thread indicator.
    await reconcileCanonicalEmbeddedMessages(queryClient, {
      entries: [{ channelId: publishChannelId, message }],
      proof: { token, signal: context.signal },
    })
  }
  return message
}

export function findCachedMessage(
  queryClient: QueryClient,
  messageId: string,
): OpenerPayload | undefined {
  const message = getCommunityDbRegistry(queryClient)?.collections.messages.get(messageId)
  if (!message?.authorId || !message.createdAt) return undefined
  return message as OpenerPayload
}

export function useMessage(
  messageId: string | null | undefined,
  accessScope?: MessageAccessScope,
): UseQueryResult<OpenerPayload> & {
  isCanonicalPending: boolean
  message: OpenerPayload | null
} {
  const registry = useOptionalCommunityDbRegistry()
  const canonicalMessages = useCanonicalMessagesById()
  const queryClient = useQueryClient()
  const accessProjection = useMemo(
    () => getActiveAccountUnreadProjection(queryClient),
    [queryClient],
  )
  const accessVersion = useSyncExternalStore(
    accessProjection.subscribe,
    accessProjection.getSnapshot,
    accessProjection.getSnapshot,
  )
  void accessVersion
  const accessAllowed = !accessScope || accessProjection.allowsAccess(accessScope)
  const enabled = !!messageId && accessAllowed
  const canonical = messageId ? canonicalMessages?.get(messageId) : undefined
  const placeholderData = useMemo(
    () => messageId && accessAllowed
      ? canonical as OpenerPayload | undefined
      : undefined,
    [accessAllowed, canonical, messageId],
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
  const isCanonicalPending = Boolean(
    enabled
    && registry
    && query.isSuccess
    && canonical === undefined,
  )
  return {
    ...query,
    isCanonicalPending,
    message: accessAllowed
      ? registry
        ? (canonical as OpenerPayload | undefined) ?? null
        : query.data ?? null
      : null,
  }
}
