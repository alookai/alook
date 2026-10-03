"use client"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { getCommunityRuntime } from "@/stores/community/runtime"


import { QueryObserver, type QueryClient } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { ConversationReadTimeoutError, conversationReadRetryPolicy, withConversationReadDeadline } from "./conversation-read"
import { ApiError } from "@/lib/errors"
import { communityKeys } from "@/lib/query-keys"
import type { MessagesPageParam } from "@/lib/community/models/message"
import { channelMessagesQueryFn, dmMessagesQueryFn } from "@/hooks/community/use-messages"
import { serverProjectedQueryFn } from "@/hooks/community/use-servers"
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
    queryClient.removeQueries({ queryKey: communityKeys.channelMeta(null, target.channelId) })
  }
  getCommunityRuntime(queryClient).messageStream.actions.removeScope(
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
        queryClient,
        onSurfaceReceipt: (receipt) => {
          recordConversationNavigationReceipt(queryClient, receipt, accessEpoch, epoch)
        },
      })
    : channelMessagesQueryFn(target.channelId, null, {
        queryClient,
        onSurfaceReceipt: (receipt) => {
          recordConversationNavigationReceipt(queryClient, receipt, accessEpoch, epoch)
        },
      })

  void queryClient.fetchInfiniteQuery({
    queryKey: messagesKey,
    queryFn,
    initialPageParam: pageParam,
    retry: conversationReadRetryPolicy(queryClient.defaultQueryOptions({ queryKey: messagesKey }).retry),
    networkMode: "always",
    // A persisted/memory-warm page is only a hint. Force this click-owned
    // query through the canonical door so a fresh receipt is always emitted.
    staleTime: 0,
  })
    .then(() => {
      if (!isCurrentConversationNavigation(queryClient, epoch, accessEpoch)) return
      commitConversationNavigationProof(queryClient, target.channelId, accessEpoch)
    })
    .catch((error) => {
      if (signal.aborted || !isCurrentConversationNavigation(queryClient, epoch, accessEpoch)) return
      const definitive = isDefinitiveAccessFailure(error)
      if (definitive) clearDeniedTarget(queryClient, target)
      failConversationNavigationProof(queryClient, epoch, accessEpoch, definitive, error instanceof ConversationReadTimeoutError)
    })

  const readKey = target.scopeKind === "dm"
    ? communityKeys.dmReadStateSnapshot(target.channelId)
    : communityKeys.channelReadStateSnapshot(target.channelId)
  const registry = getCommunityDbRegistry(queryClient)!
  void queryClient.fetchQuery({
    queryKey: readKey,
    staleTime: 0,
    retry: false,
    networkMode: "always",
    queryFn: async ({ signal: querySignal }) => {
      await registry.ready
      return withConversationReadDeadline(querySignal, (readSignal) => apiFetch<ReadSnapshot>(`/api/community/channels/${target.channelId}/read-state`, {
        signal: readSignal,
        assertActive: () => {
          if (!isCurrentConversationNavigation(queryClient, epoch, accessEpoch)) throw new DOMException("Retired conversation warmup", "AbortError")
        },
      }))
    },
  }).catch(() => undefined)

  if (target.serverId) {
    const serverId = target.serverId
    const options = { queryKey: communityKeys.server(serverId), queryFn: ({ signal }: { signal: AbortSignal }) => serverProjectedQueryFn(queryClient, serverId, signal)(), staleTime: Infinity }
    const observer = new QueryObserver(queryClient, { ...options, enabled: false })
    const release = observer.subscribe(() => undefined)
    void queryClient.fetchQuery(options).finally(release).catch(() => undefined)
  }

  return epoch
}
