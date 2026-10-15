import { collectionOptions, getLiveQueryHash, liveQueryCollectionOptions, prepareLiveQueryValue, type Context, type LiveQueryCollectionConfig, type LiveQueryOptions } from "@tanstack/react-db"
import type { CommunityDbRegistry } from "./collections"

export function communityProjection(registry: CommunityDbRegistry | null, options: unknown) {
  if (!registry) return undefined
  const prepared = prepareLiveQueryValue(options, registry.dbClient, new Set())
  if (!prepared) return undefined
  const sourceHash = getLiveQueryHash(prepared)
  const id = `community-live:${sourceHash}`
  const collection = registry.dbClient.collection(collectionOptions(id, () => liveQueryCollectionOptions({
    ...(prepared as LiveQueryCollectionConfig<Context, Record<string, unknown>>), id,
  })))
  return { prepared, sourceHash, collection }
}

export async function preloadCommunityProjection(registry: CommunityDbRegistry, options: unknown) {
  const view = communityProjection(registry, options)
  if (!view) throw new Error("Cannot preload a disabled community projection")
  await registry.dbClient.preloadLiveQuery(view.prepared as LiveQueryOptions)
  return { sourceHash: view.sourceHash, queryHash: getLiveQueryHash(view.collection) }
}

export function dehydrateCommunityProjections(registry: CommunityDbRegistry, bindings: ReadonlyArray<Awaited<ReturnType<typeof preloadCommunityProjection>>>) {
  const state = registry.dbClient.dehydrate()
  return { ...state, liveQueries: state.liveQueries?.flatMap(query => {
    const binding = bindings.find(binding => binding.sourceHash === query.queryHash)
    return binding ? [{ ...query, queryHash: binding.queryHash }] : []
  }) }
}
