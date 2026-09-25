"use client"

import { useEffect, useMemo, useSyncExternalStore } from "react"
import {
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseQueryResult,
} from "@tanstack/react-query"
import { apiFetchProfiles, messageProfilePatches } from "@/lib/community/profile-seed"
import { communityKeys } from "@/lib/query-keys"
import type { MessagesPage, Msg } from "@/lib/community/models/message"
import { useCanonicalMessagesById } from "@/lib/community-db/projections"
import {
  rememberMessageAccessScope,
  type MessageAccessScope,
} from "@/lib/community-db/message-access-scope"
import { getActiveAccountUnreadProjection } from "./account-unread-projection"

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

export const messageQueryFn = (messageId: string) => () =>
  apiFetchProfiles<OpenerPayload>(
    `/api/community/messages/${messageId}`,
    (message) => messageProfilePatches([message]),
  )

export function findCachedMessage(
  queryClient: QueryClient,
  messageId: string,
): OpenerPayload | undefined {
  for (const [, data] of queryClient.getQueriesData<{ pages?: MessagesPage[] }>({
    queryKey: communityKeys.all,
  })) {
    if (!Array.isArray(data?.pages)) continue
    for (const page of data.pages) {
      if (!Array.isArray(page.messages)) continue
      const message = page.messages.find((candidate) => candidate.id === messageId)
      if (!message?.authorId || !message.createdAt) continue
      return {
        id: message.id,
        authorId: message.authorId,
        authorName: message.authorName ?? "Unknown",
        authorAvatar: message.authorAvatar ?? "",
        authorAvatarVersion: message.authorAvatarVersion ?? 0,
        content: message.content ?? "",
        type: message.type,
        createdAt: message.createdAt,
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
        ...(message.attachments ? { attachments: message.attachments } : {}),
        ...(message.embeds ? { embeds: message.embeds } : {}),
        ...(message.reactions ? { reactions: message.reactions } : {}),
      }
    }
  }
  return undefined
}

export function useMessage(
  messageId: string | null | undefined,
  accessScope?: MessageAccessScope,
): UseQueryResult<OpenerPayload> & { message: OpenerPayload | null } {
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
  useEffect(() => {
    if (!messageId || !accessScope || !accessAllowed) return
    rememberMessageAccessScope(queryClient, messageId, accessScope)
  }, [accessAllowed, accessScope, messageId, queryClient])
  const placeholderData = useMemo(
    () => messageId && accessAllowed ? findCachedMessage(queryClient, messageId) : undefined,
    [accessAllowed, messageId, queryClient],
  )
  const query = useQuery({
    queryKey: enabled ? communityKeys.message(messageId!) : communityKeys.message("__none__"),
    queryFn: enabled
      ? messageQueryFn(messageId!)
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
      ? (canonical as OpenerPayload | undefined) ?? query.data ?? null
      : null,
  }
}
