import type { QueryClient, QueryKey } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import { useCommunityStore } from "@/stores/community"
import { useCommunityWsStore } from "@/stores/community/ws"
import { invalidateForumSidebarBaseExact } from "@/hooks/community/use-forum-sidebar-threads"
import { clearAllTypingIndicators } from "@/hooks/community/community-ws/typing"
import { communityWsReconnectPolicies } from "@/hooks/community/community-ws/registry"
import {
  trackCommunityWsReconcileComplete,
  trackCommunityWsReconcileFailure,
  type CommunityWsReconcilePolicy,
} from "@/lib/analytics"

const EXACT_SERVER_QUERY_FAMILIES = new Set([
  "forum-sidebar-base",
  "forum-sidebar-unread-fallbacks",
  "members",
  "presence",
  "invites",
  "invitable-friends",
])

const DERIVED_SERVER_QUERY_FAMILIES = new Set([
  "forum-sidebar-retained",
  "channel-meta",
  "forum-opener-hint",
])

type ServerQueryKey = readonly ["community", "servers", string, ...unknown[]]

function isServerQueryPrefix(key: QueryKey, serverId?: string): key is ServerQueryKey {
  return key[0] === "community"
    && key[1] === "servers"
    && typeof key[2] === "string"
    && key[2] !== "__none__"
    && (serverId === undefined || key[2] === serverId)
}

function isRecognizedServerQueryKey(key: QueryKey): key is ServerQueryKey {
  if (!isServerQueryPrefix(key)) return false
  if (key.length === 3) return true
  if (key.length === 4) {
    return typeof key[3] === "string" && EXACT_SERVER_QUERY_FAMILIES.has(key[3])
  }
  return key.length === 5
    && typeof key[3] === "string"
    && DERIVED_SERVER_QUERY_FAMILIES.has(key[3])
    && typeof key[4] === "string"
    && key[4].length > 0
}

function isDerivedServerAccessQueryKey(key: QueryKey, serverId: string) {
  if (!isServerQueryPrefix(key, serverId)) return false
  if (key.length === 4) return key[3] === "forum-sidebar-unread-fallbacks"
  return key.length === 5
    && typeof key[3] === "string"
    && DERIVED_SERVER_QUERY_FAMILIES.has(key[3])
    && typeof key[4] === "string"
    && key[4].length > 0
}

function cachedServerIds(queryKeys: readonly QueryKey[]) {
  const serverIds = new Set<string>()
  for (const key of queryKeys) {
    if (isRecognizedServerQueryKey(key)) serverIds.add(key[2])
  }
  return [...serverIds]
}

async function reconcileCachedServer(queryClient: QueryClient, serverId: string) {
  queryClient.removeQueries({
    predicate: (query) => isDerivedServerAccessQueryKey(query.queryKey, serverId),
  })

  const settled = await Promise.allSettled([
    queryClient.invalidateQueries({
      queryKey: communityKeys.server(serverId),
      exact: true,
      refetchType: "active",
    }),
    queryClient.invalidateQueries({
      queryKey: communityKeys.members(serverId),
      exact: true,
      refetchType: "active",
    }),
    queryClient.invalidateQueries({
      queryKey: communityKeys.presence(serverId),
      exact: true,
      refetchType: "active",
    }),
    queryClient.invalidateQueries({
      queryKey: communityKeys.invites(serverId),
      exact: true,
      refetchType: "active",
    }),
    invalidateForumSidebarBaseExact(queryClient, serverId),
  ])
  if (settled.some((result) => result.status === "rejected")) {
    throw new Error("server reconciliation failed")
  }
}

function policyExecutors(queryClient: QueryClient): Record<CommunityWsReconcilePolicy, () => void | Promise<void>> {
  const sub = useCommunityStore.getState().subscription
  const queryKeys = queryClient.getQueryCache().getAll().map((query) => query.queryKey)
  return {
    "focused-messages": async () => {
      const operations: Promise<unknown>[] = []
      if (sub.channelId) {
        operations.push(queryClient.invalidateQueries({
          queryKey: communityKeys.channelMessages(sub.channelId),
          refetchType: "active",
        }))
      }
      if (sub.dmConversationId) {
        operations.push(queryClient.invalidateQueries({
          queryKey: communityKeys.dmMessages(sub.dmConversationId),
          refetchType: "active",
        }))
      }
      const settled = await Promise.allSettled(operations)
      if (settled.some((result) => result.status === "rejected")) throw new Error("focused messages failed")
    },
    "focused-opener": async () => {
      const parentMessageId = useCommunityStore.getState().currentChannelMeta?.parentMessageId
      if (!parentMessageId) return
      await queryClient.invalidateQueries({
        queryKey: communityKeys.message(parentMessageId),
        exact: true,
        refetchType: "active",
      })
    },
    "focused-channel-roster": async () => {
      if (!sub.channelId) return
      const settled = await Promise.allSettled([
        queryClient.invalidateQueries({
          queryKey: communityKeys.channelMembers(sub.channelId),
          refetchType: "active",
        }),
        queryClient.invalidateQueries({
          queryKey: communityKeys.channelAddableMembers(sub.channelId),
          refetchType: "active",
        }),
      ])
      if (settled.some((result) => result.status === "rejected")) throw new Error("focused roster failed")
    },
    "focused-pins": async () => {
      const channelId = sub.channelId ?? sub.dmConversationId
      if (!channelId) return
      await queryClient.invalidateQueries({ queryKey: communityKeys.pins(channelId), refetchType: "active" })
    },
    "focused-threads": async () => {
      if (!sub.channelId) return
      const settled = await Promise.allSettled([
        queryClient.invalidateQueries({ queryKey: communityKeys.threads(sub.channelId), refetchType: "active" }),
        queryClient.invalidateQueries({ queryKey: communityKeys.threadParticipants(sub.channelId), refetchType: "active" }),
      ])
      if (settled.some((result) => result.status === "rejected")) throw new Error("focused threads failed")
    },
    "inbox-dms": async () => {
      const settled = await Promise.allSettled([
        queryClient.invalidateQueries({ queryKey: communityKeys.inbox(), refetchType: "active" }),
        queryClient.invalidateQueries({ queryKey: communityKeys.dms(), refetchType: "active" }),
      ])
      if (settled.some((result) => result.status === "rejected")) throw new Error("inbox reconciliation failed")
    },
    "all-cached-servers": async () => {
      const serverIds = cachedServerIds(queryKeys)
      const settled = await Promise.allSettled([
        queryClient.invalidateQueries({
          queryKey: communityKeys.servers(),
          exact: true,
          refetchType: "active",
        }),
        ...serverIds.map((serverId) => reconcileCachedServer(queryClient, serverId)),
      ])
      if (settled.some((result) => result.status === "rejected")) throw new Error("cached server reconciliation failed")
    },
    "friends": async () => {
      await queryClient.invalidateQueries({ queryKey: communityKeys.friends(), refetchType: "active" })
    },
    "presence-overlay": () => useCommunityWsStore.getState().resetPresence(),
    "status-overlay": () => useCommunityWsStore.getState().resetUserStatuses(),
    "ephemeral-typing": clearAllTypingIndicators,
    "machines": async () => {
      await queryClient.invalidateQueries({ queryKey: communityKeys.machines(), refetchType: "active" })
    },
    "bot-audits": async () => {
      await queryClient.invalidateQueries({
        queryKey: [...communityKeys.all, "bot"],
        exact: false,
        refetchType: "active",
      })
    },
  }
}

async function executePolicy(
  policy: CommunityWsReconcilePolicy,
  executor: () => void | Promise<void>,
) {
  let result: void | Promise<void>
  try {
    result = executor()
  } catch {
    trackCommunityWsReconcileFailure({ policy, reason: "sync-throw" })
    return false
  }
  try {
    await result
    return true
  } catch {
    trackCommunityWsReconcileFailure({ policy, reason: "async-rejection" })
    return false
  }
}

export type CommunityWsReconcileSummary = {
  policyCount: number
  successCount: number
  failureCount: number
  durationMs: number
  reconnectDurationMs: number
}

export async function reconcileCommunityWsReconnect(
  queryClient: QueryClient,
  reconnectDurationMs = 0,
): Promise<CommunityWsReconcileSummary> {
  const startedAt = Date.now()
  const executors = policyExecutors(queryClient)
  const resetPolicies = new Set<CommunityWsReconcilePolicy>([
    "presence-overlay",
    "status-overlay",
  ])
  const resetResults = communityWsReconnectPolicies
    .filter((policy) => resetPolicies.has(policy))
    .map((policy) => executePolicy(policy, executors[policy]))
  const authoritativeResults = communityWsReconnectPolicies
    .filter((policy) => !resetPolicies.has(policy))
    .map((policy) => executePolicy(policy, executors[policy]))
  const settled = await Promise.allSettled(
    [...resetResults, ...authoritativeResults],
  )
  const successCount = settled.filter(
    (result) => result.status === "fulfilled" && result.value,
  ).length
  const summary = {
    policyCount: settled.length,
    successCount,
    failureCount: settled.length - successCount,
    durationMs: Math.max(0, Date.now() - startedAt),
    reconnectDurationMs,
  }
  trackCommunityWsReconcileComplete(summary)
  return summary
}
