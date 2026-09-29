"use client"

import { type QueryClient } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { ApiError } from "@/lib/errors"
import { communityKeys } from "@/lib/query-keys"
import { useMessageStreamStore } from "@/stores/community/message-stream"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { purgeCommunityChannel } from "@/lib/community-db/sync"
import type { MessageCollectionDemand } from "@/lib/community-db/message-resource"
import {
  createServerDetailResourceQueryFn,
  serverDetailResourceKey,
} from "@/lib/community-db/server-detail-resource"
import {
  beginConversationNavigationProof,
  commitConversationNavigationPublication,
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
  const readKey = target.scopeKind === "dm"
    ? communityKeys.dmReadStateSnapshot(target.channelId)
    : communityKeys.channelReadStateSnapshot(target.channelId)
  queryClient.removeQueries({ queryKey: readKey })
  const registry = getCommunityDbRegistry(queryClient)
  if (registry) {
    void registry.purgeMessageScope?.(target.channelId)
    purgeCommunityChannel(registry, target.channelId)
  }
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
  const registry = getCommunityDbRegistry(queryClient)
  const base = target.anchorMessageId
    ? { mode: "anchor" as const, anchor: target.anchorMessageId }
    : { mode: "tail" as const }
  const demand = (direction: "older" | "newer"): MessageCollectionDemand => ({
    scope: {
      accountId: registry?.scopeId ?? target.viewerId,
      kind: target.scopeKind === "dm" ? "dm" : "server-channel",
      serverId: target.serverId ?? null,
      channelId: target.channelId,
    },
    tag: null,
    sequence: {
      base,
      direction,
      order: ["seq", "asc", "id", "asc"],
    },
  })
  const directions = target.anchorMessageId
    ? ["older", "newer"] as const
    : ["older"] as const
  const acquired: Array<Awaited<ReturnType<NonNullable<typeof registry>["preloadMessageWindow"]>>> = []
  const releaseAcquired = async () => {
    await Promise.all(acquired.splice(0).map((window) => window.release()))
  }
  const messageWarmup = registry
    ? Promise.all(directions.map(async (direction) => {
        const window = await registry.preloadMessageWindow(
          demand(direction),
          target.anchorMessageId ? 26 : 50,
          signal,
        )
        acquired.push(window)
        return window
      }))
    : Promise.reject(new Error("Community DB registry unavailable for message warmup"))

  void messageWarmup
    .then((windows) => {
      if (!isCurrentConversationNavigation(queryClient, epoch, accessEpoch)) return
      const receipt = windows.find((window) => window.publication.surfaceReceipt)
        ?.publication.surfaceReceipt
      if (receipt) {
        recordConversationNavigationReceipt(queryClient, receipt, accessEpoch, epoch)
      }
      const older = windows.find((_window, index) => directions[index] === "older")
      commitConversationNavigationPublication(queryClient, { ...target }, accessEpoch, {
        requestedAnchorMessageId: target.anchorMessageId ?? null,
        coveredAnchorMessageIds: !target.anchorMessageId && older && !older.publication.hasMore
          ? older.publication.rows.map((message) => message.id)
          : undefined,
      })
      commitConversationNavigationProof(queryClient, target.channelId, accessEpoch)
    })
    .catch(async (error) => {
      await releaseAcquired()
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
    const scopeId = registry?.scopeId ?? target.viewerId
    void queryClient.query({
      queryKey: serverDetailResourceKey(scopeId, target.serverId),
      queryFn: createServerDetailResourceQueryFn(queryClient, scopeId),
      staleTime: Infinity,
    }).catch(() => undefined)
  }

  return epoch
}
