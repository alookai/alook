import { collectionOptions, getLiveQueryHash, liveQueryCollectionOptions, prepareLiveQueryValue, type Context, type LiveQueryCollectionConfig } from "@tanstack/react-db"
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
  return { collection }
}
