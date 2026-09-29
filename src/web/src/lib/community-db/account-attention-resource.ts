import type { QueryClient, QueryFunctionContext } from "@tanstack/react-query"
import {
  AccountAttentionSnapshotSchema,
  type AccountAttentionSnapshot,
} from "@alook/shared"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import type {
  AttentionItemRow,
  AttentionScopeRow,
  MessageRow,
} from "./schema"

type AttentionProtectionState = {
  optimisticClears: Set<symbol>
  optimisticScopeDeletes: Map<symbol, {
    scopeId: string
    targetSeq: number
    clearedAttentionCount: number
    itemIds: Set<string>
    requiresReconcileOnRestore: boolean
  }>
  optimisticItemDeletes: Map<symbol, Set<string>>
}

const attentionProtectionStates = new WeakMap<QueryClient, AttentionProtectionState>()

export function attentionProtectionState(queryClient: QueryClient) {
  let state = attentionProtectionStates.get(queryClient)
  if (!state) {
    state = {
      optimisticClears: new Set(),
      optimisticScopeDeletes: new Map(),
      optimisticItemDeletes: new Map(),
    }
    attentionProtectionStates.set(queryClient, state)
  }
  return state
}

class StaleAttentionReadError extends Error {
  constructor() {
    super("stale D1 attention read")
    this.name = "StaleAttentionReadError"
  }
}

export function accountAttentionResourceKey() {
  return communityKeys.accountAttention()
}

export function selectAccountAttentionResource(
  queryClient: QueryClient,
  snapshot: AccountAttentionSnapshot,
  currentMessages: Iterable<MessageRow>,
): AccountAttentionSnapshot {
  const protection = attentionProtectionState(queryClient)
  const scopesById = new Map<string, AttentionScopeRow>(
    snapshot.scopes.map((row) => [row.scopeId, { ...row }]),
  )
  const itemsById = new Map<string, AttentionItemRow>(
    snapshot.items.map((row) => [row.id, { ...row }]),
  )
  const optimisticClear = protection.optimisticClears.size > 0
  const optimisticScopeDeletes = [...protection.optimisticScopeDeletes.values()]
  const optimisticItemDeletes = new Set(
    [...protection.optimisticItemDeletes.values()].flatMap((ids) => [...ids]),
  )
  const attentionMessages = new Map(
    [...currentMessages].map((message) => [message.id, message]),
  )
  for (const message of snapshot.included?.messages ?? []) {
    if (typeof message.id === "string") attentionMessages.set(message.id, message as MessageRow)
  }
  const fencedItems = new Set<string>()
  for (const item of itemsById.values()) {
    const fenced = optimisticScopeDeletes.some((entry) => (
      item.scopeId === entry.scopeId
      && (
        entry.itemIds.has(item.id)
        || (item.messageId
          && (attentionMessages.get(item.messageId)?.seq ?? Number.POSITIVE_INFINITY)
            <= entry.targetSeq)
      )
    ))
    if (fenced) fencedItems.add(item.id)
  }
  const itemDeleteCountsByScope = new Map<string, number>()
  for (const item of itemsById.values()) {
    if (
      !optimisticItemDeletes.has(item.id)
      || !item.scopeId
      || item.kind !== "mention" && item.kind !== "reply"
    ) continue
    itemDeleteCountsByScope.set(
      item.scopeId,
      (itemDeleteCountsByScope.get(item.scopeId) ?? 0) + 1,
    )
  }
  const scopes = optimisticClear ? [] : [...scopesById.values()].flatMap((scope) => {
    const targetSeq = optimisticScopeDeletes.reduce((target, entry) => (
      entry.scopeId === scope.scopeId ? Math.max(target, entry.targetSeq) : target
    ), -1)
    if (targetSeq < 0) {
      const deletedAttentionCount = itemDeleteCountsByScope.get(scope.scopeId) ?? 0
      if (deletedAttentionCount === 0) return [scope]
      const attentionCount = Math.max(0, scope.attentionCount - deletedAttentionCount)
      if (!scope.ordinaryUnread && attentionCount === 0) return []
      return [{
        ...scope,
        attentionCount,
        lastAttentionSeq: attentionCount === 0 ? null : scope.lastAttentionSeq,
      }]
    }
    const clearedAttentionCount = optimisticScopeDeletes.reduce((count, entry) => (
      entry.scopeId === scope.scopeId ? count + entry.clearedAttentionCount : count
    ), 0)
    const ordinaryUnread = scope.ordinaryUnread && scope.lastUnreadSeq > targetSeq
    const lastAttentionSeq = scope.lastAttentionSeq !== null
      && scope.lastAttentionSeq !== undefined
      && scope.lastAttentionSeq > targetSeq
      ? scope.lastAttentionSeq
      : null
    const attentionCount = lastAttentionSeq === null
      ? 0
      : Math.max(0, scope.attentionCount - clearedAttentionCount)
    return ordinaryUnread || attentionCount > 0
      ? [{ ...scope, ordinaryUnread, lastAttentionSeq, attentionCount }]
      : []
  })
  const items = [...itemsById.values()].filter((item) => (
    (!optimisticClear || item.kind === "friend_request")
    && !fencedItems.has(item.id)
    && !optimisticItemDeletes.has(item.id)
  ))
  return { ...snapshot, scopes, items }
}

export function createAccountAttentionResourceQueryFn(
  queryClient: QueryClient,
  readMessages: () => Iterable<MessageRow>,
) {
  return async ({ signal }: QueryFunctionContext = {} as QueryFunctionContext) => {
    const response = await apiFetch<AccountAttentionSnapshot & { stale?: boolean }>(
      "/api/community/users/me/attention",
      signal ? { signal } : undefined,
    )
    if (response.stale) throw new StaleAttentionReadError()
    const snapshot = AccountAttentionSnapshotSchema.parse(response)
    return selectAccountAttentionResource(queryClient, snapshot, readMessages())
  }
}

export function selectAttentionScopes(resource: AccountAttentionSnapshot) {
  return resource.scopes
}

export function selectAttentionItems(resource: AccountAttentionSnapshot) {
  return resource.items
}
