import { commandObservation } from "@/lib/observability/context"
import { clearComposerAttachmentSessionsForAccount } from "./composer-attachment-session"
import type { ApiRequestOptions } from "@/lib/api/client"
import { getCommunityDbRegistry, type CommunityDbRegistry } from "@/lib/community-db/collections"
import { assertCommunityLiveSnapshotTokenCurrent, type CommunityLiveSnapshotToken } from "@/lib/community-db/sync"
import type { QueryClient } from "@tanstack/react-query"

import { observeAccountQueryCancellation } from "@/lib/observability/cancellation"

export function retireCommunityAccount(registry: CommunityDbRegistry) {
  registry.runtime.lifecycle.setState((state) => state.active ? { active: false, generation: state.generation + 1 } : state)
  if (registry.accountId) clearComposerAttachmentSessionsForAccount(registry.accountId)
  registry.runtime.transport.send = null
  observeAccountQueryCancellation(registry.queryClient.getQueryCache().getAll().filter(query => query.state.fetchStatus === "fetching"))
  void registry.queryClient.cancelQueries()
  registry.queryClient.clear()
}
export function communityRequestOptions(queryClient: QueryClient, token: CommunityLiveSnapshotToken, signal?: AbortSignal, assertActive = () => assertCommunityLiveSnapshotTokenCurrent(queryClient, token, signal)): ApiRequestOptions & { assertActive: () => void } {
  const registry = getCommunityDbRegistry(queryClient)
  return { observation: commandObservation(token), authenticationAccount: registry?.accountId ?? undefined, signal, assertActive, onUnauthorized: async () => {
    assertActive()
    if (!registry || getCommunityDbRegistry(queryClient) !== registry || !registry.authenticationView.get().active) return false
    const generation = registry.authenticationView.get().generation
    retireCommunityAccount(registry)
    await registry.retireDisk().catch(() => undefined)
    const viewer = registry.sessionViewer()
    return registry.authenticationView.get().active && registry.authenticationView.get().generation === generation && (viewer === undefined || viewer === null || viewer === registry.accountId)
  } }
}
