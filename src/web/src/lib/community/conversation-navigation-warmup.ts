"use client"

import { type QueryClient } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { ApiError } from "@/lib/errors"
import { communityKeys } from "@/lib/query-keys"
import type { MessagesPageParam } from "@/lib/community/models/message"
import { channelMessagesQueryFn, dmMessagesQueryFn } from "@/hooks/community/use-messages"
import { serverQueryFn, type ServerDetail } from "@/hooks/community/use-servers"
import { useMessageStreamStore } from "@/stores/community/message-stream"
import {
  beginConversationNavigationProof,
  commitConversationNavigationProof,
  failConversationNavigationProof,
  isCurrentConversationNavigation,
  recordConversationNavigationReceipt,
  registerConversationNavigationRecovery,
  type ConversationNavigationTarget,
} from "./conversation-navigation-proof"

type ReadSnapshot = {
  lastReadMessageId: string | null
  lastReadAt: string | null
  lastReadSeq: number
}

function isDefinitiveAccessFailure(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 403 || error.status === 404)
}

function clearDeniedTarget(queryClient: QueryClient, target: ConversationNavigationTarget) {
  const messagesKey = target.scopeKind === "dm"
    ? communityKeys.dmMessages(target.channelId)
    : communityKeys.channelMessages(target.channelId)
  const readKey = target.scopeKind === "dm"
    ? communityKeys.dmReadStateSnapshot(target.channelId)
    : communityKeys.channelReadStateSnapshot(target.channelId)
  queryClient.removeQueries({ queryKey: messagesKey })
  queryClient.removeQueries({ queryKey: readKey })
  if (target.serverId) {
    queryClient.removeQueries({ queryKey: communityKeys.channelMeta(target.serverId, target.channelId) })
  } else {
    queryClient.removeQueries({ queryKey: communityKeys.dmRouteVerification(target.channelId) })
  }
  useMessageStreamStore.getState().removeScope(
    target.scopeKind === "dm"
      ? { kind: "dm", id: target.channelId }
      : { kind: "channel", id: target.channelId, serverId: target.serverId! },
  )
}

export function startConversationNavigationWarmup(
  queryClient: QueryClient,
  target: ConversationNavigationTarget,
  accessEpoch: number,
  recoveryAttempt = 0,
) {
  const { epoch, signal } = beginConversationNavigationProof(
    queryClient,
    target,
    accessEpoch,
    recoveryAttempt,
  )
  registerConversationNavigationRecovery(queryClient, epoch, (nextAccessEpoch, nextAttempt) => {
    startConversationNavigationWarmup(queryClient, target, nextAccessEpoch, nextAttempt)
  })
  const pageParam: MessagesPageParam = target.anchorMessageId
    ? { mode: "anchor", anchor: target.anchorMessageId }
    : { mode: "newest" }
  const messagesKey = target.scopeKind === "dm"
    ? communityKeys.dmMessages(target.channelId)
    : communityKeys.channelMessages(target.channelId)
  const queryFn = target.scopeKind === "dm"
    ? dmMessagesQueryFn(target.channelId, {
        onSurfaceReceipt: (receipt) => {
          recordConversationNavigationReceipt(queryClient, receipt, accessEpoch, epoch)
        },
      })
    : channelMessagesQueryFn(target.channelId, null, {
        onSurfaceReceipt: (receipt) => {
          recordConversationNavigationReceipt(queryClient, receipt, accessEpoch, epoch)
        },
      })

  void queryClient.fetchInfiniteQuery({
    queryKey: messagesKey,
    queryFn,
    initialPageParam: pageParam,
    // A persisted/memory-warm page is only a hint. Force this click-owned
    // query through the canonical door so a fresh receipt is always emitted.
    staleTime: 0,
  })
    .then(() => {
      if (!isCurrentConversationNavigation(queryClient, epoch, accessEpoch)) return
      commitConversationNavigationProof(queryClient, target.channelId, accessEpoch)
    })
    .catch((error) => {
      if (signal.aborted) return
      const definitive = isDefinitiveAccessFailure(error)
      if (definitive) clearDeniedTarget(queryClient, target)
      failConversationNavigationProof(queryClient, epoch, accessEpoch, definitive)
    })

  const readKey = target.scopeKind === "dm"
    ? communityKeys.dmReadStateSnapshot(target.channelId)
    : communityKeys.channelReadStateSnapshot(target.channelId)
  void apiFetch<ReadSnapshot>(`/api/community/channels/${target.channelId}/read-state`, { signal })
    .then((snapshot) => {
      if (!isCurrentConversationNavigation(queryClient, epoch, accessEpoch)) return
      queryClient.setQueryData(readKey, snapshot)
    })
    .catch(() => undefined)

  if (target.serverId) {
    void serverQueryFn(queryClient, target.serverId, signal)()
      .then((detail) => {
        if (!isCurrentConversationNavigation(queryClient, epoch, accessEpoch)) return
        queryClient.setQueryData<ServerDetail>(communityKeys.server(target.serverId!), detail)
      })
      .catch(() => undefined)
  }

  return epoch
}
