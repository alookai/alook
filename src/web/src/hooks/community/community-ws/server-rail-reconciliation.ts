import type { QueryClient } from "@tanstack/react-query"
import type { CommunityServerRailChanged } from "@alook/shared"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { serverRailMutationKey } from "@/lib/community-db/server-rail"
import { communityKeys } from "@/lib/query-keys"
import type { StructureTreeEventContext } from "./handler-context"

export async function reconcileCommunityServerRail(queryClient: QueryClient) {
  const registry = getCommunityDbRegistry(queryClient)
  if (!registry?.runtime.lifecycle.get().active) return
  const generation = registry.runtime.lifecycle.get().generation
  const current = () => getCommunityDbRegistry(queryClient) === registry
    && registry.runtime.lifecycle.get().active && registry.runtime.lifecycle.get().generation === generation
  const pending = () => queryClient.isMutating({ mutationKey: serverRailMutationKey, exact: true }) > 0
  if (pending()) {
    await new Promise<void>((resolve) => {
      const unsubscribe = queryClient.getMutationCache().subscribe(() => {
        if (!pending()) { unsubscribe(); resolve() }
      })
    })
  }
  if (!current()) return
  const queries = [communityKeys.servers(), communityKeys.folders(), communityKeys.channelRefDirectory()]
    .flatMap((queryKey) => queryClient.getQueryCache().findAll({ queryKey, exact: true }))
  await Promise.all(queries.map((query) => queryClient.cancelQueries({ queryKey: query.queryKey, exact: true, predicate: (candidate) => candidate === query })))
  if (!current()) return
  await Promise.all(queries.filter((query) => queryClient.getQueryCache().get(query.queryHash) === query)
    .map((query) => queryClient.invalidateQueries({ queryKey: query.queryKey, exact: true, predicate: (candidate) => candidate === query }, { cancelRefetch: false })))
}

export function handleServerRailChanged(_event: CommunityServerRailChanged, { queryClient }: StructureTreeEventContext) {
  return reconcileCommunityServerRail(queryClient)
}
