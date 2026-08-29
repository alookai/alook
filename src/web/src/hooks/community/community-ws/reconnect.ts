import type { QueryClient, QueryKey } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import { useCommunityStore } from "@/stores/community"
import { useCommunityWsStore } from "@/stores/community/ws"
import { invalidateForumSidebarBaseExact } from "@/hooks/community/use-forum-sidebar-threads"
import { clearAllTypingIndicators } from "@/hooks/community/community-ws/typing"
import { communityWsReconnectPolicies } from "@/hooks/community/community-ws/registry"
import { userProfileQueryFn } from "@/hooks/community/use-user-profile"
import { reconcileFocusedMessageQueries } from "@/hooks/community/community-ws/reconnect-messages"
import { reconcileAccountReadState } from "@/hooks/community/community-ws/read-state-reconciliation"
import {
  trackCommunityWsReconcileComplete,
  trackCommunityWsReconcileFailure,
  type CommunityWsReconcilePolicy,
} from "@/lib/analytics"

const RESET_POLICIES = new Set<CommunityWsReconcilePolicy>([
  "presence-overlay",
  "status-overlay",
  "ephemeral-typing",
])

const FOCUSED_POLICIES = new Set<CommunityWsReconcilePolicy>([
  "focused-messages",
  "focused-opener",
  "focused-channel-roster",
  "focused-pins",
  "focused-threads",
])

const BACKGROUND_RECONCILE_CONCURRENCY = 3

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
  const derivedRevalidation = queryClient.invalidateQueries({
    predicate: (query) => isDerivedServerAccessQueryKey(query.queryKey, serverId),
    refetchType: "active",
  })

  const settled = await Promise.allSettled([
    derivedRevalidation,
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

function policyExecutors(
  queryClient: QueryClient,
  viewerUserId?: string | null,
): Record<CommunityWsReconcilePolicy, () => void | Promise<void>> {
  const sub = useCommunityStore.getState().subscription
  const queryKeys = queryClient.getQueryCache().getAll().map((query) => query.queryKey)
  return {
    "focused-messages": async () => {
      const operations: Promise<unknown>[] = []
      if (sub.channelId) {
        operations.push(reconcileFocusedMessageQueries(
          queryClient,
          "channel",
          sub.channelId,
        ))
      }
      if (sub.dmConversationId) {
        operations.push(reconcileFocusedMessageQueries(
          queryClient,
          "dm",
          sub.dmConversationId,
        ))
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
    "cached-read-state": async () => {
      await reconcileAccountReadState(queryClient, { invalidateSurfaces: false })
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
    "presence-overlay": async () => {
      const profiles = useCommunityWsStore.getState()
      profiles.patchProfiles(
        profiles.beginProfileSnapshot(),
        [...profiles.profilesByUserId.values()]
          .filter((profile) => (
            profile.id !== viewerUserId && profile.presence === "online"
          ))
          .map((profile) => ({ id: profile.id, presence: "offline" as const })),
      )
    },
    "status-overlay": async () => {
      const profiles = useCommunityWsStore.getState()
      profiles.patchProfiles(
        profiles.beginProfileSnapshot(),
        [...profiles.profilesByUserId.keys()].map((id) => ({
          id,
          status: { statusEmoji: null, statusText: null },
        })),
      )
    },
    "identity-surfaces": async () => {
      const hasIdentitySurface = queryClient.getQueryCache().getAll().some((query) => (
        query.queryKey[0] === "community"
        && ["profile", "bots", "invite-info"].includes(String(query.queryKey[1]))
      ))
      const settled = await Promise.allSettled([
        ...(viewerUserId
          ? [userProfileQueryFn(viewerUserId)()]
          : []),
        ...(hasIdentitySurface
          ? [queryClient.invalidateQueries({
              predicate: (query) => query.queryKey[0] === "community"
                && ["profile", "bots", "invite-info"].includes(String(query.queryKey[1])),
              refetchType: "active",
            })]
          : []),
      ])
      if (settled.some((result) => result.status === "rejected")) {
        throw new Error("identity reconciliation failed")
      }
    },
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

async function executePoliciesBounded(
  policies: readonly CommunityWsReconcilePolicy[],
  executors: Record<CommunityWsReconcilePolicy, () => void | Promise<void>>,
  concurrency: number,
): Promise<boolean[]> {
  const results = new Array<boolean>(policies.length)
  let nextIndex = 0
  const worker = async () => {
    while (nextIndex < policies.length) {
      const index = nextIndex
      nextIndex += 1
      const policy = policies[index]!
      results[index] = await executePolicy(policy, executors[policy])
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, concurrency), policies.length) },
      () => worker(),
    ),
  )
  return results
}

export type CommunityWsReconcileSummary = {
  policyCount: number
  successCount: number
  failureCount: number
  durationMs: number
  reconnectDurationMs: number
}

type CommunityWsReconnectOptions = {
  excludePolicies?: readonly CommunityWsReconcilePolicy[]
  viewerUserId?: string | null
}

export async function reconcileCommunityWsReconnect(
  queryClient: QueryClient,
  reconnectDurationMs = 0,
  options: CommunityWsReconnectOptions = {},
): Promise<CommunityWsReconcileSummary> {
  const startedAt = Date.now()
  const executors = policyExecutors(queryClient, options.viewerUserId)
  const excludedPolicies = new Set(options.excludePolicies ?? [])
  const policies = communityWsReconnectPolicies.filter((policy) => !excludedPolicies.has(policy))
  const resetPolicies = policies.filter((policy) => RESET_POLICIES.has(policy))
  const focusedMessagePolicies = policies.filter((policy) => policy === "focused-messages")
  const focusedRoutePolicies = policies.filter(
    (policy) => FOCUSED_POLICIES.has(policy) && policy !== "focused-messages",
  )
  const backgroundPolicies = policies.filter(
    (policy) => !RESET_POLICIES.has(policy) && !FOCUSED_POLICIES.has(policy),
  )

  const resetResults = await Promise.all(
    resetPolicies.map((policy) => executePolicy(policy, executors[policy])),
  )
  const focusedMessageResults = await Promise.all(
    focusedMessagePolicies.map((policy) => executePolicy(policy, executors[policy])),
  )
  const focusedRouteResults = await Promise.all(
    focusedRoutePolicies.map((policy) => executePolicy(policy, executors[policy])),
  )
  const backgroundResults = await executePoliciesBounded(
    backgroundPolicies,
    executors,
    BACKGROUND_RECONCILE_CONCURRENCY,
  )
  const results = [
    ...resetResults,
    ...focusedMessageResults,
    ...focusedRouteResults,
    ...backgroundResults,
  ]
  const successCount = results.filter(Boolean).length
  const summary = {
    policyCount: results.length,
    successCount,
    failureCount: results.length - successCount,
    durationMs: Math.max(0, Date.now() - startedAt),
    reconnectDurationMs,
  }
  trackCommunityWsReconcileComplete(summary)
  return summary
}
