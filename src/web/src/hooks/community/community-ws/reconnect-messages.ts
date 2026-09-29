import type { QueryClient } from "@tanstack/react-query"
import { ApiError } from "@/lib/errors"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { purgeCommunityChannel } from "@/lib/community-db/sync"
import { getMessageOverlay } from "@/stores/community/message-stream"

type GapRepairScope = {
  kind: "channel" | "dm"
  scopeId: string
  serverId?: string
}

const gapRepairs = new WeakMap<QueryClient, Map<string, Promise<void>>>()

function isDefinitiveAccessDenial(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 403 || error.status === 404)
}

function knownFocusedMessageSeq(
  queryClient: QueryClient,
  scope: GapRepairScope,
): number {
  const registry = getCommunityDbRegistry(queryClient)
  let latest = 0
  for (const message of registry?.collections.messages.values() ?? []) {
    if (message.channelId === scope.scopeId) latest = Math.max(latest, message.seq ?? 0)
  }
  const overlay = scope.kind === "channel"
    ? getMessageOverlay({
        kind: "channel",
        id: scope.scopeId,
        serverId: scope.serverId ?? "",
      })
    : getMessageOverlay({ kind: "dm", id: scope.scopeId })
  for (const message of overlay.liveById.values()) {
    latest = Math.max(latest, message.seq ?? 0)
  }
  return latest
}

/**
 * Detect a missing focused message before the incoming frame is projected.
 * One descriptor refresh runs per scope; later gap frames share it.
 */
export function scheduleFocusedMessageGapRepair(
  queryClient: QueryClient,
  scope: GapRepairScope,
  incomingSeq: number,
): Promise<void> | null {
  if (incomingSeq <= knownFocusedMessageSeq(queryClient, scope) + 1) return null
  let repairs = gapRepairs.get(queryClient)
  if (!repairs) {
    repairs = new Map()
    gapRepairs.set(queryClient, repairs)
  }
  const key = `${scope.kind}:${scope.scopeId}`
  const existing = repairs.get(key)
  if (existing) return existing
  const repair = reconcileFocusedMessageQueries(
    queryClient,
    scope.kind,
    scope.scopeId,
  ).catch(() => {
    // Realtime delivery is fail-open. Reconnect runs the same authoritative
    // descriptor reconciliation if this best-effort repair fails.
  }).finally(() => {
    repairs!.delete(key)
    if (repairs!.size === 0) gapRepairs.delete(queryClient)
  })
  repairs.set(key, repair)
  return repair
}

/** Refresh every active canonical message sequence for the focused scope. */
export async function reconcileFocusedMessageQueries(
  queryClient: QueryClient,
  kind: "channel" | "dm",
  scopeId: string,
): Promise<void> {
  const registry = getCommunityDbRegistry(queryClient)
  if (!registry) return
  try {
    await registry.reconcileMessageScope(
      kind === "channel" ? "server-channel" : "dm",
      scopeId,
    )
  } catch (error) {
    if (!isDefinitiveAccessDenial(error)) throw error
    await registry.purgeMessageScope(scopeId)
    purgeCommunityChannel(registry, scopeId)
  }
}
