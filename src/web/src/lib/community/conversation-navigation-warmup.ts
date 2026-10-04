"use client"
import { getCommunityRuntime } from "@/stores/community/runtime"


import { InfiniteQueryObserver, QueryObserver, type InfiniteData, type QueryClient } from "@tanstack/react-query"
import { conversationReadRetryPolicy } from "./conversation-read"
import { ApiError } from "@/lib/errors"
import { communityKeys } from "@/lib/query-keys"
import type { MessagesPage, MessagesPageParam } from "@/lib/community/models/message"
import { channelMessagesQueryFn, dmMessagesQueryFn } from "@/hooks/community/use-messages"
import { channelReadStateSnapshotQueryFn } from "@/hooks/community/use-channel-read-state"
import { serverProjectedQueryFn } from "@/hooks/community/use-servers"
import {
  beginConversationNavigationProof,
  commitConversationNavigationProof,
  failConversationNavigationProof,
  getConversationNavigationProof,
  isCurrentConversationNavigation,
  recordConversationNavigationReceipt,
  registerConversationNavigationRecovery,
  type ConversationNavigationTarget,
} from "./conversation-navigation-proof"

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

  void queryClient.cancelQueries({ queryKey: messagesKey, exact: true })
  queryClient.setQueryData<InfiniteData<MessagesPage, MessagesPageParam>>(messagesKey, (current) => current
    ? { ...current, pageParams: [pageParam, ...current.pageParams.slice(1)] }
    : current)
  const messagesOptions = {
    queryKey: messagesKey,
    queryFn,
    initialPageParam: pageParam,
    pages: 1,
    getNextPageParam: () => undefined,
    retry: conversationReadRetryPolicy(queryClient.defaultQueryOptions({ queryKey: messagesKey }).retry),
    networkMode: "always" as const,
    // A persisted/memory-warm page is only a hint. Force this click-owned
    // query through the canonical door so a fresh receipt is always emitted.
    staleTime: 0,
  }
  const messagesObserver = new InfiniteQueryObserver(queryClient, {
    ...messagesOptions, enabled: false,
  })
  const releaseMessages = messagesObserver.subscribe(() => undefined)
  void queryClient.fetchInfiniteQuery(messagesOptions)
    .then(() => {
      if (!isCurrentConversationNavigation(queryClient, epoch, accessEpoch)) return
      commitConversationNavigationProof(queryClient, target.channelId, accessEpoch)
      if (getConversationNavigationProof(queryClient)?.status === "warming") {
        failConversationNavigationProof(queryClient, epoch, accessEpoch, false, true)
      }
    })
    .catch((error) => {
      if (signal.aborted || !isCurrentConversationNavigation(queryClient, epoch, accessEpoch)) return
      const definitive = isDefinitiveAccessFailure(error)
      if (definitive) clearDeniedTarget(queryClient, target)
      failConversationNavigationProof(queryClient, epoch, accessEpoch, definitive, true)
    })
    .finally(releaseMessages)

  const readKey = target.scopeKind === "dm"
    ? communityKeys.dmReadStateSnapshot(target.channelId)
    : communityKeys.channelReadStateSnapshot(target.channelId)
  void queryClient.fetchQuery({
    queryKey: readKey,
    staleTime: 0,
    retry: false,
    networkMode: "always",
    queryFn: channelReadStateSnapshotQueryFn(target.channelId, target.scopeKind, {
      waitForRegistryReady: true,
      assertNavigationCurrent: () => {
        if (!isCurrentConversationNavigation(queryClient, epoch, accessEpoch)) throw new DOMException("Retired conversation warmup", "AbortError")
      },
    }),
  }).catch(() => undefined)

  if (target.serverId) {
    const serverId = target.serverId
    const queryKey = communityKeys.server(serverId)
    const options = { queryKey, queryFn: ({ signal }: { signal: AbortSignal }) => serverProjectedQueryFn(queryClient, serverId, signal)(), staleTime: Infinity, networkMode: "always" as const, retry: conversationReadRetryPolicy(queryClient.defaultQueryOptions({ queryKey }).retry) }
    const observer = new QueryObserver(queryClient, { ...options, enabled: false })
    const release = observer.subscribe(() => undefined)
    void queryClient.fetchQuery(options).finally(release).catch(() => undefined)
  }

  return epoch
}
